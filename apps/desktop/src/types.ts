export type Framework =
  | "node_js"
  | "nest_js"
  | "next_js"
  | "fast_api"
  | "vite"
  | "uni_app"
  | "taro"
  | "prisma"
  | "pnpm_workspace";

export type DiagnosticLevel = "info" | "warning" | "error";

export interface FrameworkDetection {
  framework: Framework;
  path: string;
  confidence: number;
  evidence: string[];
}

export interface DetectedService {
  id: string;
  package_name: string;
  path: string;
  kind: "api" | "web" | "worker" | "static";
  framework: Framework;
  dockerfile: string | null;
  suggested_port: number;
  build_command: string | null;
  start_command: string | null;
  dependency_file: string | null;
  confidence: number;
}

export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  path: string | null;
}

export interface InspectionReport {
  project_root: string;
  project_name: string;
  package_manager: string;
  monorepo: boolean;
  frameworks: FrameworkDetection[];
  services: DetectedService[];
  prisma_schemas: string[];
  dockerfiles: string[];
  environment_files: string[];
  environment_variables: Array<{
    name: string;
    secret: boolean;
    source: string;
  }>;
  diagnostics: Diagnostic[];
}

export interface ValidationIssue {
  level: DiagnosticLevel;
  code: string;
  field: string;
  message: string;
}

export interface ManifestValidation {
  valid: boolean;
  issues: ValidationIssue[];
}

export type EnvironmentName = "development" | "staging" | "production";

export interface EnvironmentPlanSummary {
  name: EnvironmentName;
  branch: string | null;
  target: string;
  automatic: boolean;
  approval_required: boolean;
}

export interface FileChange {
  path: string;
  kind: "create" | "update" | "unchanged";
  before?: string;
  after: string;
  sensitive: boolean;
}

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  executor: "local" | "cnb" | "server" | "user";
  destructive: boolean;
}

export interface UserAction {
  id: string;
  title: string;
  detail: string;
  category: "authorization" | "server" | "dns" | "secret" | "approval";
  required: boolean;
}

export interface DeploymentPlan {
  id: string;
  project: string;
  generated_at: string;
  environments: EnvironmentPlanSummary[];
  changes: FileChange[];
  steps: PlanStep[];
  user_actions: UserAction[];
  blockers?: PlanBlocker[];
  warnings: string[];
}

export interface PlanBlocker {
  code: string;
  title: string;
  detail: string;
  service: string | null;
  resolution: string;
}

export interface WorkspacePreview {
  inspection: InspectionReport;
  manifestYaml: string;
  validation: ManifestValidation;
  plan: DeploymentPlan;
  manifestExists: boolean;
}

export interface ToolStatus {
  name: string;
  available: boolean;
  version: string | null;
  required_for: string;
  resolution: string | null;
}

export interface SystemPreflight {
  operating_system: string;
  architecture: string;
  tools: ToolStatus[];
  ready_for_cloud_deploy: boolean;
  ready_for_local_preview: boolean;
}

export interface ProviderCheck {
  provider: string;
  ok: boolean;
  summary: string;
  details: string[];
  code?: string | null;
  nextSteps?: string[];
  retryable?: boolean;
}

export interface UserFacingIssue {
  code: string;
  title: string;
  message: string;
  nextSteps: string[];
  technicalDetails: string[];
  retryable: boolean;
}

export interface CnbRepositoryInput {
  token: string;
  slug: string;
  name: string;
  description: string;
  privateRepo: boolean;
}

export interface CnbRepositoryResult {
  repository: string;
  visibility: "private" | "public";
}

export interface CnbProjectSetup {
  repository: string;
  created: boolean;
}

export interface CnbNamespace {
  path: string;
  displayName: string;
  accessRole: string;
  canCreateRepository: boolean;
}

export interface SourceSyncResult {
  repository: string;
  branch: string;
  commitSha: string;
  committed: boolean;
}

export interface CnbAccount {
  connected: boolean;
  displayName: string;
  username: string;
  defaultNamespace: string;
  namespaces: CnbNamespace[];
}

export interface SecretStatus {
  key: string;
  stored: boolean;
}

export type ConfigProfileKind =
  "ai" | "database" | "redis" | "dns" | "registry" | "custom";
export type ConfigProfileScope = "any" | "local" | "remote";

export interface ConfigProfile {
  id: string;
  kind: ConfigProfileKind;
  provider: string;
  name: string;
  scope: ConfigProfileScope;
  values: Record<string, string>;
  secretFields: string[];
  configuredSecretFields: string[];
  isDefault: boolean;
  updatedAt: string;
}

export interface ConfigProfileInput {
  id?: string;
  kind: ConfigProfileKind;
  provider: string;
  name: string;
  scope: ConfigProfileScope;
  values: Record<string, string>;
  secretFields: string[];
  secrets: Record<string, string>;
  isDefault: boolean;
}

export interface ProjectProfileBinding {
  environment: RuntimeEnvironment;
  kind: ConfigProfileKind;
  profileId: string;
}

export interface RuntimeConfigRecommendation {
  content: string;
  appliedProfiles: string[];
  filledVariables: string[];
}

export interface ExistingProjectConfig {
  sourceFiles: string[];
  content: string;
}

export interface LocalEnvWriteResult {
  path: string;
  written: boolean;
  requiresConfirmation: boolean;
  backupPath: string | null;
}

export interface LocalPreviewService {
  id: string;
  kind: "api" | "web" | "worker" | "static";
  buildStrategy: "existing" | "generated" | "needs_input";
  dockerfile: string;
  hostPort: number | null;
  url: string | null;
  running: boolean;
}

export interface LocalPreviewStatus {
  state: "not_prepared" | "stopped" | "running" | "partial" | "unavailable";
  message: string;
  composePath: string;
  envReady: boolean;
  services: LocalPreviewService[];
  writtenFiles: string[];
}

export interface LocalDevelopmentSupport {
  available: boolean;
  serviceCount: number;
  message: string;
}

export interface LocalInfrastructureStatus {
  state: "not_prepared" | "stopped" | "running" | "partial" | "unavailable";
  message: string;
  postgresRunning: boolean;
  redisRunning: boolean;
  postgresPort: number;
  redisPort: number;
  profilesReady: boolean;
}

export interface PipelineIdentityResult {
  created: boolean;
  fingerprint: string;
}

export type RuntimeEnvironment = "development" | "staging" | "production";

export interface RuntimeSecretStatus {
  environment: RuntimeEnvironment;
  variable: string;
  stored: boolean;
}

export interface RuntimeConfigFile {
  environment: RuntimeEnvironment;
  filename: string;
  sourceFiles: string[];
  content: string;
  templateContent: string;
  requiredVariables: string[];
  stored: boolean;
  authorizationRequired: boolean;
}

export interface RuntimeConfigStatus {
  environment: RuntimeEnvironment;
  filename: string;
  stored: boolean;
}

export interface RuntimeConfigSyncStatus {
  stored: boolean;
  synchronized: boolean;
}

export interface CnbSecretBundle {
  environment: "staging" | "production";
  filename: string;
  fileUrl: string;
  content: string;
  missingVariables: string[];
  deployKeyFingerprint: string;
}

export interface ApplyResult {
  planId: string;
  writtenFiles: string[];
  backupDirectory: string;
}

export type OnboardingStep =
  | "inspection"
  | "connections"
  | "recommendation"
  | "requirements"
  | "review"
  | "deploying"
  | "workspace";

export interface RecentProject {
  id: string;
  path: string;
  name: string;
  currentStep: OnboardingStep;
  manifestExists: boolean;
  serviceCount: number;
  lastOpenedAt: string;
  pathExists: boolean;
  latestStatus: DeploymentRunStatus | null;
  latestEnvironment: "staging" | "production" | null;
  latestMessage: string | null;
  latestRunId?: string | null;
  latestSourceRunId?: string | null;
  latestCurrentStage?: string | null;
  latestActionKind?: string | null;
  latestIssueCode?: string | null;
  latestCompletedSteps?: string[];
  latestUpdatedAt?: string | null;
  activeRunCount: number;
}

export interface RelinkProjectResult {
  path: string;
  name: string;
}

export type NavigationSection =
  "overview" | "environments" | "connections" | "plan";

export interface ServerForm {
  name: string;
  host: string;
  user: string;
  port: number;
  keyPath: string;
  hostFingerprint?: string;
}

export interface SshIdentity {
  name: string;
  path: string;
  source: string;
  fingerprint: string | null;
  managed: boolean;
}

export interface GeneratedSshIdentity {
  identity: SshIdentity;
  publicKey: string;
  created: boolean;
}

export interface ServerResource extends ServerForm {
  id: string;
  keyPathExists: boolean;
  lastCheckedAt: string;
}

export interface RouteConflictCheck {
  conflicts: Array<{
    host: string;
    source: "main" | "managed";
  }>;
  takeoverAvailable: boolean;
}

export interface DnsProviderHint {
  zone: string;
  provider: string;
  managementUrl: string | null;
  nameServers: string[];
}

export type DeploymentRunStatus =
  "queued" | "running" | "needs_action" | "success" | "failed" | "cancelled";

export interface DeploymentArtifact {
  service: string;
  image: string;
  digest: string;
}

export interface DeploymentRun {
  id: string;
  projectPath: string;
  projectName: string;
  environment: "staging" | "production";
  status: DeploymentRunStatus;
  currentStage: string;
  buildSerial: string | null;
  commitSha: string | null;
  sourceTitle?: string | null;
  sourceRunId: string | null;
  candidateTag: string | null;
  artifacts: DeploymentArtifact[];
  actionKind: string | null;
  actionUrl: string | null;
  issueCode: string | null;
  repository: string;
  branch: string;
  message: string;
  completedSteps: string[];
  startedAt: string;
  updatedAt: string;
}
