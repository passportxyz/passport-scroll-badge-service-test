export const getIamSecrets = (IAM_SERVER_SSM_ARN: string) => [
  {
    name: "SCROLL_RPC_URL",
    valueFrom: `${IAM_SERVER_SSM_ARN}:SCROLL_RPC_URL::`,
  },
  {
    name: "SCROLL_EAS_SCAN_URL",
    valueFrom: `${IAM_SERVER_SSM_ARN}:SCROLL_EAS_SCAN_URL::`,
  },
  {
    name: "PASSPORT_SCORE_SCHEMA_UID",
    valueFrom: `${IAM_SERVER_SSM_ARN}:PASSPORT_SCORE_SCHEMA_UID::`,
  },
  {
    name: "PASSPORT_SCORE_ATTESTER_CONTRACT_ADDRESS",
    valueFrom: `${IAM_SERVER_SSM_ARN}:PASSPORT_SCORE_ATTESTER_CONTRACT_ADDRESS::`,
  },
  {
    name: "ATTESTER_PROXY_ADDRESS",
    valueFrom: `${IAM_SERVER_SSM_ARN}:ATTESTER_PROXY_ADDRESS::`,
  },
  {
    name: "ATTESTATION_SIGNER_PRIVATE_KEY",
    valueFrom: `${IAM_SERVER_SSM_ARN}:ATTESTATION_SIGNER_PRIVATE_KEY::`,
  },
];
