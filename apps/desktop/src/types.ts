export type Framework =
  | "nest_js"
  | "next_js"
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
  warnings: string[];
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

export interface PipelineIdentityResult {
  created: boolean;
  fingerprint: string;
}

export interface RuntimeSecretStatus {
  environment: "staging" | "production";
  variable: string;
  stored: boolean;
}

export interface RuntimeConfigFile {
  environment: "staging" | "production";
  filename: string;
  sourceFiles: string[];
  content: string;
  templateContent: string;
  stored: boolean;
}

export interface RuntimeConfigStatus {
  environment: "staging" | "production";
  filename: string;
  stored: boolean;
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
  activeRunCount: number;
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
