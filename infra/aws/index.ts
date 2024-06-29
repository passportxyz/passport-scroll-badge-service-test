import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { getIamSecrets } from "./secrets";

const IAM_SERVER_SSM_ARN = `${process.env["IAM_SERVER_SSM_ARN"]}`;

const route53Domain = `${process.env["ROUTE_53_DOMAIN"]}`;

export const dockerScrollServiceImage = `${process.env.SCROLL_BADGE_SERVICE_IMAGE_TAG || ""}`;

const stack = pulumi.getStack();
const region = aws.getRegion({});

const coreInfraStack = new pulumi.StackReference(`gitcoin/core-infra/${stack}`);
const passportInfraStack = new pulumi.StackReference(`gitcoin/passport/${stack}`);

const passportClusterArn = passportInfraStack.getOutput("passportClusterArn");
const passportServiceRoleArn = passportInfraStack.getOutput("passportServiceRoleArn");

const vpcId = coreInfraStack.getOutput("vpcId");

const albDnsName = coreInfraStack.getOutput("coreAlbDns");
const albZoneId = coreInfraStack.getOutput("coreAlbZoneId");
const albHttpsListenerArn = coreInfraStack.getOutput("coreAlbHttpsListenerArn");

const defaultTags = {
  ManagedBy: "pulumi",
  PulumiStack: stack,
  Project: "passport",
};

const logsRetention = Object({
  review: 1,
  staging: 7,
  production: 30,
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
  // stickiness: { // is Stickiness required ?
  //     type: "app_cookie",
  //     cookieName: "gtc-passport",
  //     cookieDuration: 86400,
  //     enabled: true
  // },
  targetType: "ip",
  tags: {
    ...defaultTags,
    Name: `scroll-badge-service-tg`,
  },
});


export const listnerearn = albHttpsListenerArn
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
        values: [route53Domain],
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
      name: "scroll-badge-service-td",
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
      environment: [
        // todo might need to add env vars here
        // {
        //   name: "REDIS_URL",
        //   value: _redisConnectionUrl,
        // },
        // {
        //   name: "DATA_SCIENCE_API_URL",
        //   value: passportDataScienceEndpoint,
        // },
      ],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": "passport-iam", // "${serviceLogGroup.name}`,
          "awslogs-region": "us-west-2", // `${regionId}`,
          "awslogs-create-group": "true",
          "awslogs-stream-prefix": "iam",
        },
      },
      secrets: getIamSecrets(IAM_SERVER_SSM_ARN),
      mountPoints: [],
      volumesFrom: [],
    }
  ]),
  executionRoleArn: passportServiceRoleArn,
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
        containerName: "iam",
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


// Nodejs base iamge for lambdas
// https://docs.aws.amazon.com/lambda/latest/dg/nodejs-image.html
// avoid creating new load balancer, use existing one
// Possible to route from load balancer to ECS service via api.passport.gitcoin.co/scroll or scroll.api.passport.gitcoin.co
//
