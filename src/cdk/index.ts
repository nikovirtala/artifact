// `@nikovirtala/artifact/cdk`: the construct library (docs/decisions/0071).
export {
  type ArtifactApiDomain,
  type ArtifactDataRetention,
  ArtifactHosting,
  type ArtifactHostingProps,
  type ArtifactLimits,
  type ArtifactViewDomain,
} from "./artifact-hosting.ts";
export { ArtifactCertificate, type ArtifactCertificateProps } from "./certificate.ts";
export { ArtifactIdentity, type ArtifactIdentityBinding } from "./identity.ts";
export { AWS_LIMIT_CEILINGS, AWS_LIMIT_DEFAULTS } from "./validate.ts";
