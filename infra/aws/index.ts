import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { getIamSecrets } from "./secrets";

export const SCROLL_SECRETS_ARN = `${process.env["SCROLL_SECRETS_ARN"]}`;
export const VC_SECRETS_ARN = `${process.env["VC_SECRETS_ARN"]}`;

export const ROUTE53_DOMAIN = `${process.env["ROUTE_53_DOMAIN"]}`;

export const dockerScrollServiceImage = `${
  process.env.SCROLL_BADGE_SERVICE_IMAGE_TAG || ""
}`;

const stack = pulumi.getStack();
const region = aws.getRegion({});

const defaultTags = {
  ManagedBy: "pulumi",
  PulumiStack: stack,
  Project: "scroll-badge",
};

const logsRetention = Object({
  review: 1,
  staging: 7,
  production: 30,
});

const coreInfraStack = new pulumi.StackReference(`gitcoin/core-infra/${stack}`);
const passportInfraStack = new pulumi.StackReference(
  `gitcoin/passport/${stack}`
);

const passportClusterArn = passportInfraStack.getOutput("passportClusterArn");

const vpcId = coreInfraStack.getOutput("vpcId");

const albHttpsListenerArn = coreInfraStack.getOutput("coreAlbHttpsListenerArn");

const serviceRole = new aws.iam.Role("scroll-badge-ecs-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "EcsAssume",
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
          Service: "ecs-tasks.amazonaws.com",
        },
      },
    ],
  }),
  inlinePolicies: [
    {
      name: "allow_iam_secrets_access",
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Action: ["secretsmanager:GetSecretValue"],
            Effect: "Allow",
            Resource: [SCROLL_SECRETS_ARN, VC_SECRETS_ARN],
          },
        ],
      }),
    },
  ],
  managedPolicyArns: [
    "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
  ],
  tags: {
    ...defaultTags,
  },
});

const serviceLogGroup = new aws.cloudwatch.LogGroup("scroll-badge-service", {
  name: "scroll-badge-service",
  retentionInDays: logsRetention[stack],
  tags: {
    ...defaultTags,
  },
});

const vpcPrivateSubnets = coreInfraStack.getOutput("privateSubnetIds");

//////////////////////////////////////////////////////////////
// Service SG
//////////////////////////////////////////////////////////////

const serviceSG = new aws.ec2.SecurityGroup(`scroll-badge-service-sg`, {
  name: `scroll-badge-service-sg`,
  vpcId: vpcId,
  description: `Security Group for scroll-badge-service service.`,
  tags: {
    ...defaultTags,
    Name: `scroll-badge-service`,
  },
});

// do no group the security group definition & rules in the same resource =>
// it will cause the sg to be destroyed and recreated everytime the rules change
// By managing them separately is easier to update the security group rules even outside of this stack
const sgIngressRule80 = new aws.ec2.SecurityGroupRule(
  `scroll-badge-service-sgr`,
  {
    securityGroupId: serviceSG.id,
    type: "ingress",
    fromPort: 80,
    toPort: 80,
    protocol: "tcp",
    cidrBlocks: ["0.0.0.0/0"], // TODO: improvements: allow only from the ALB's security group id
  },
  {
    dependsOn: [serviceSG],
  }
);

// Allow all outbound traffic
const sgEgressRule = new aws.ec2.SecurityGroupRule(
  `scroll-badge-service-all`,
  {
    securityGroupId: serviceSG.id,
    type: "egress",
    fromPort: 0,
    toPort: 0,
    protocol: "-1",
    cidrBlocks: ["0.0.0.0/0"],
  },
  {
    dependsOn: [serviceSG],
  }
);

//////////////////////////////////////////////////////////////
// Load Balancer listerner rule & target group
//////////////////////////////////////////////////////////////

const albTargetGroup = new aws.lb.TargetGroup(`scroll-badge-service-tg`, {
  name: `scroll-badge-service-tg`,
  vpcId: vpcId,
  healthCheck: {
    enabled: true,
    healthyThreshold: 3,
    interval: 30,
    matcher: "200",
    path: "/health",
    port: "traffic-port",
    protocol: "HTTP",
    timeout: 5,
    unhealthyThreshold: 5,
  },
  port: 80,
  protocol: "HTTP",
  targetType: "ip",
  tags: {
    ...defaultTags,
    Name: `scroll-badge-service-tg`,
  },
});

const albListenerRule = new aws.lb.ListenerRule(`scroll-badge-service-https`, {
  listenerArn: albHttpsListenerArn,
  priority: 10,
  actions: [
    {
      type: "forward",
      targetGroupArn: albTargetGroup.arn,
    },
  ],
  conditions: [
    {
      hostHeader: {
        values: [ROUTE53_DOMAIN],
      },
    },
    {
      pathPattern: {
        values: ["/scroll*"],
      },
    },
  ],
  tags: {
    ...defaultTags,
    Name: `scroll-badge-service-https`,
  },
});

//////////////////////////////////////////////////////////////
// ECS Task & Service
//////////////////////////////////////////////////////////////
const taskDefinition = new aws.ecs.TaskDefinition(`scroll-badge-service-td`, {
  family: `scroll-badge-service-td`,
  containerDefinitions: JSON.stringify([
    {
      name: "scroll-badge-service",
      image: dockerScrollServiceImage,
      cpu: 512,
      memory: 1024,
      links: [],
      essential: true,
      portMappings: [
        {
          containerPort: 80,
          hostPort: 80,
          protocol: "tcp",
        },
      ],
      environment: [],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": "scroll-badge-service", // "${serviceLogGroup.name}`,
          "awslogs-region": "us-west-2", // `${regionId}`,
          "awslogs-create-group": "true",
          "awslogs-stream-prefix": "scroll",
        },
      },
      secrets: getIamSecrets(SCROLL_SECRETS_ARN, VC_SECRETS_ARN),
      mountPoints: [],
      volumesFrom: [],
    },
  ]),
  executionRoleArn: serviceRole.arn,
  cpu: "512",
  memory: "1024",
  networkMode: "awsvpc",
  requiresCompatibilities: ["FARGATE"],
  tags: {
    ...defaultTags,
    EcsService: `scroll-badge-service`,
  },
});

const service = new aws.ecs.Service(
  `scroll-badge-service`,
  {
    cluster: passportClusterArn,
    desiredCount: stack === "production" ? 2 : 1,
    enableEcsManagedTags: true,
    enableExecuteCommand: false,
    launchType: "FARGATE",
    loadBalancers: [
      {
        containerName: "scroll-badge-service",
        containerPort: 80,
        targetGroupArn: albTargetGroup.arn,
      },
    ],
    name: `scroll-badge-service`,
    networkConfiguration: {
      subnets: vpcPrivateSubnets,
      securityGroups: [serviceSG.id],
    },
    propagateTags: "TASK_DEFINITION",
    taskDefinition: taskDefinition.arn,
    tags: {
      ...defaultTags,
      Name: `scroll-badge-service`,
    },
  },
  {
    dependsOn: [albTargetGroup, taskDefinition],
  }
);
