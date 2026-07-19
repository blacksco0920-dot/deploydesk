import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getRuntimeConfigSyncStatus,
  listConfigProfileBindings,
  listConfigProfiles,
  loadExistingProjectConfig,
  loadRuntimeConfig,
  recommendRuntimeConfig,
  saveConfigProfile,
  setEnvironmentConfigBindings,
  storeRuntimeConfig,
  syncRuntimeConfigToServer,
  writeLocalEnv,
} from "../api";
import type {
  ConfigProfile,
  RuntimeConfigFile,
  RuntimeEnvironment,
  ServerForm,
} from "../types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface RuntimeConfigFieldsProps {
  displayName?: string;
  environment: RuntimeEnvironment;
  onError: (message: string) => void;
  onMarkOptional?: (key: string) => Promise<boolean>;
  onReadyChange?: (ready: boolean, checking: boolean) => void;
  path: string;
  secretVariables?: string[];
  server?: ServerForm;
  verifiedReady?: boolean;
}

interface EnvField {
  comment: string;
  key: string;
  lineIndex: number;
  required: boolean;
  value: string;
}

interface CommonConfigDraft {
  description: string;
  field: EnvField;
  profileId?: string;
  value: string;
}

function environmentLabel(environment: RuntimeEnvironment) {
  if (environment === "development") return "本机";
  if (environment === "staging") return "测试";
  if (environment === "production") return "正式";
  return "运行";
}

export function RuntimeConfigFields({
  displayName,
  environment,
  onError,
  onMarkOptional,
  onReadyChange,
  path,
  secretVariables = [],
  server,
  verifiedReady = false,
}: RuntimeConfigFieldsProps) {
  const [document, setDocument] = useState<RuntimeConfigFile | null>(null);
  const [content, setContent] = useState("");
  const [profiles, setProfiles] = useState<ConfigProfile[]>([]);
  const [boundProfileIds, setBoundProfileIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState("");
  const [bindingFailure, setBindingFailure] = useState("");
  const [bindingRefreshPending, setBindingRefreshPending] = useState(false);
  const [applyingProfile, setApplyingProfile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [remoteSynchronized, setRemoteSynchronized] = useState(false);
  const [remoteCheckComplete, setRemoteCheckComplete] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [pendingOptional, setPendingOptional] = useState<EnvField | null>(null);
  const [commonConfigDraft, setCommonConfigDraft] =
    useState<CommonConfigDraft | null>(null);
  const [commonConfigFailure, setCommonConfigFailure] = useState("");
  const [savingCommonConfig, setSavingCommonConfig] = useState(false);
  const onErrorRef = useRef(onError);
  const automaticSaveAttempted = useRef("");
  const skipNextRemoteCheck = useRef(false);
  const refreshRequest = useRef(0);
  const profileMutationInFlight = useRef(false);
  const label = displayName ?? environmentLabel(environment);
  const heading = environment === "development" ? "必要配置" : `${label}配置`;

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const refresh = useCallback(
    async (authorize = false) => {
      const request = refreshRequest.current + 1;
      refreshRequest.current = request;
      setLoading(true);
      setLoadFailure("");
      setBindingFailure("");
      setBindingRefreshPending(false);
      let runtimeLoaded = false;
      try {
        const loaded = await loadRuntimeConfig(path, environment, authorize);
        if (request !== refreshRequest.current) return;
        runtimeLoaded = true;
        let nextContent = fillDeploymentRuntimeDefaults(
          loaded.content,
          environment,
        );
        setDocument(loaded);
        setContent(nextContent);
        setProfiles([]);
        setBoundProfileIds([]);

        const [availableProfiles, bindings] = await Promise.all([
          listConfigProfiles(),
          listConfigProfileBindings(path, environment),
        ]);
        if (request !== refreshRequest.current) return;
        const reusableProfiles = availableProfiles.filter(isReusableVariable);
        const profilesById = new Map(
          availableProfiles.map((profile) => [profile.id, profile]),
        );
        const documentVariables = new Set(
          parseEnvFields(nextContent, loaded.requiredVariables).map(
            (field) => field.key,
          ),
        );
        const validBindingIds = bindings
          .map((binding) => binding.profileId)
          .filter((profileId) => {
            const profile = profilesById.get(profileId);
            if (!profile) return false;
            return (
              !isReusableVariable(profile) ||
              documentVariables.has(profile.values.env_name)
            );
          });
        if (validBindingIds.length !== bindings.length) {
          await setEnvironmentConfigBindings(
            path,
            environment,
            validBindingIds,
          );
          if (request !== refreshRequest.current) return;
        }
        const reusableProfileIds = new Set(
          reusableProfiles.map((profile) => profile.id),
        );
        const activeProfileIds = validBindingIds.filter((profileId) =>
          reusableProfileIds.has(profileId),
        );
        setProfiles(reusableProfiles);
        setBoundProfileIds(activeProfileIds);
        if (activeProfileIds.length && !loaded.authorizationRequired) {
          const protectedReference = reusableProfiles.some(
            (profile) =>
              activeProfileIds.includes(profile.id) &&
              profileHasProtectedValue(profile),
          );
          if (protectedReference) {
            setBindingRefreshPending(true);
          } else {
            nextContent = clearProfileBoundValues(
              nextContent,
              reusableProfiles,
              activeProfileIds,
            );
            const recommendation = await recommendRuntimeConfig(
              path,
              environment,
              activeProfileIds,
              nextContent,
            );
            if (request !== refreshRequest.current) return;
            nextContent = recommendation.content;
            setContent(nextContent);
          }
        }
      } catch (error) {
        if (request !== refreshRequest.current) return;
        const message = toMessage(error);
        if (runtimeLoaded) {
          setBindingFailure(message);
        } else {
          setDocument(null);
          setContent("");
          setProfiles([]);
          setBoundProfileIds([]);
          setLoadFailure(message);
          onErrorRef.current(message);
        }
      } finally {
        if (request === refreshRequest.current) setLoading(false);
      }
    },
    [environment, path],
  );

  useEffect(() => {
    void refresh(false);
    return () => {
      refreshRequest.current += 1;
    };
  }, [refresh]);

  const fields = useMemo(
    () =>
      parseEnvFields(content, document?.requiredVariables ?? []).filter(
        (field) => !abcDeployManagedVariable(field.key),
      ),
    [content, document?.requiredVariables],
  );
  const missingRequired = fields.filter(
    (field) =>
      field.required &&
      !field.value.trim() &&
      !managedRemoteDependency(environment, field.key),
  );
  const missing = fields.filter(
    (field) =>
      !field.value.trim() && !managedRemoteDependency(environment, field.key),
  );
  const hasReusableProjectConfig = missingRequired.some((field) =>
    reusableVariableAcrossEnvironments(field.key),
  );
  const hasGeneratableSecret = missingRequired.some((field) =>
    internalRuntimeSecret(field.key),
  );
  const dirty = Boolean(document && content !== document.content);
  const checksRemoteServer = environment !== "development" && Boolean(server);
  const usesVerifiedRemoteConfig = Boolean(
    checksRemoteServer && document?.authorizationRequired && verifiedReady,
  );
  const checkingRemoteSync = Boolean(
    checksRemoteServer && document?.stored && !dirty && !remoteCheckComplete,
  );
  const needsRemoteSync = Boolean(
    checksRemoteServer &&
    document?.stored &&
    !dirty &&
    remoteCheckComplete &&
    !remoteSynchronized,
  );
  const ready = Boolean(
    usesVerifiedRemoteConfig ||
    (document?.stored &&
      !dirty &&
      missingRequired.length === 0 &&
      (!checksRemoteServer || remoteSynchronized)),
  );
  const automaticEmptySaveKey =
    ((environment === "staging" && server) ||
      environment.startsWith("path-")) &&
    document
      ? [
          path,
          server?.host ?? environment,
          server?.port ?? "",
          server?.user ?? "",
          document.stored ? "stored" : "new",
          content,
        ].join("\u0000")
      : "";
  const automaticEmptySavePending = Boolean(
    automaticEmptySaveKey &&
    !loading &&
    !document?.authorizationRequired &&
    fields.every(
      (field) =>
        Boolean(field.value.trim()) ||
        managedRemoteDependency(environment, field.key),
    ) &&
    !ready &&
    !(document?.stored && !remoteCheckComplete) &&
    automaticSaveAttempted.current !== automaticEmptySaveKey,
  );
  const automaticLocalSaveKey =
    environment === "development" && document
      ? [path, document.stored ? "stored" : "new", content].join("\u0000")
      : "";
  const automaticLocalSavePending = Boolean(
    automaticLocalSaveKey &&
    !loading &&
    !document?.stored &&
    !document?.authorizationRequired &&
    fields.length > 0 &&
    missingRequired.length === 0 &&
    automaticSaveAttempted.current !== automaticLocalSaveKey,
  );
  const automaticSavePending = Boolean(
    automaticEmptySavePending || automaticLocalSavePending,
  );
  const checkingReady = Boolean(
    loading ||
    saving ||
    automaticSavePending ||
    (checksRemoteServer &&
      document?.stored &&
      !document.authorizationRequired &&
      !dirty &&
      !remoteCheckComplete),
  );
  const visibleFields = useMemo(() => {
    if (usesVerifiedRemoteConfig) return [];
    const sorted = [...fields].sort((left, right) => {
      const rank = (field: EnvField) =>
        field.value.trim() ? (field.required ? 2 : 3) : field.required ? 0 : 1;
      return rank(left) - rank(right) || left.lineIndex - right.lineIndex;
    });
    return showAll
      ? sorted
      : sorted.filter(
          (field) =>
            !field.value.trim() &&
            !managedRemoteDependency(environment, field.key),
        );
  }, [environment, fields, showAll, usesVerifiedRemoteConfig]);

  useEffect(() => {
    onReadyChange?.(ready, checkingReady);
  }, [checkingReady, onReadyChange, ready]);

  useEffect(() => {
    if (environment === "development" || !server) {
      setRemoteSynchronized(false);
      setRemoteCheckComplete(true);
      return;
    }
    if (!document?.stored || document.authorizationRequired || dirty) {
      setRemoteSynchronized(false);
      setRemoteCheckComplete(true);
      return;
    }
    if (skipNextRemoteCheck.current) {
      skipNextRemoteCheck.current = false;
      setRemoteSynchronized(true);
      setRemoteCheckComplete(true);
      return;
    }
    let active = true;
    setRemoteSynchronized(false);
    setRemoteCheckComplete(false);
    getRuntimeConfigSyncStatus(path, environment, server)
      .then((status) => {
        if (active) setRemoteSynchronized(status.synchronized);
      })
      .catch(() => {
        if (active) setRemoteSynchronized(false);
      })
      .finally(() => {
        if (active) setRemoteCheckComplete(true);
      });
    return () => {
      active = false;
    };
  }, [
    dirty,
    document?.authorizationRequired,
    document?.stored,
    environment,
    path,
    server,
  ]);

  function updateValue(field: EnvField, value: string) {
    setContent((current) => replaceEnvLine(current, field.lineIndex, value));
  }

  async function refreshBoundProfileValues() {
    if (
      profileMutationInFlight.current ||
      !boundProfileIds.length ||
      document?.authorizationRequired
    )
      return;
    profileMutationInFlight.current = true;
    setApplyingProfile(true);
    setBindingFailure("");
    try {
      const source = clearProfileBoundValues(
        content,
        profiles,
        boundProfileIds,
      );
      const result = await recommendRuntimeConfig(
        path,
        environment,
        boundProfileIds,
        source,
      );
      setContent(result.content);
      setBindingRefreshPending(false);
    } catch (error) {
      const message = toMessage(error);
      setBindingFailure(message);
      onError(message);
    } finally {
      profileMutationInFlight.current = false;
      setApplyingProfile(false);
    }
  }

  async function useProfile(field: EnvField, profileId: string) {
    if (!profileId || profileMutationInFlight.current) return;
    profileMutationInFlight.current = true;
    setApplyingProfile(true);
    setBindingFailure("");
    try {
      const idsForOtherFields = boundProfileIds.filter((boundId) => {
        const profile = profiles.find((candidate) => candidate.id === boundId);
        return profile?.values.env_name !== field.key;
      });
      if (profileId === "__manual__") {
        await setEnvironmentConfigBindings(
          path,
          environment,
          idsForOtherFields,
        );
        setBoundProfileIds(idsForOtherFields);
        setBindingRefreshPending(
          profiles.some(
            (profile) =>
              idsForOtherFields.includes(profile.id) &&
              profileHasProtectedValue(profile),
          ),
        );
        return;
      }
      const nextProfileIds = Array.from(
        new Set([...idsForOtherFields, profileId]),
      );
      const clearedContent = replaceEnvLine(content, field.lineIndex, "");
      const result = await recommendRuntimeConfig(
        path,
        environment,
        nextProfileIds,
        clearedContent,
      );
      if (!result.filledVariables.includes(field.key)) {
        onError(`所选配置没有为 ${field.key} 提供可用值`);
        return;
      }
      await setEnvironmentConfigBindings(path, environment, nextProfileIds);
      setBoundProfileIds(nextProfileIds);
      setBindingRefreshPending(false);
      setContent(result.content);
    } catch (error) {
      const message = toMessage(error);
      setBindingFailure(message);
      onError(message);
    } finally {
      profileMutationInFlight.current = false;
      setApplyingProfile(false);
    }
  }

  function openCommonConfig(field: EnvField) {
    setCommonConfigFailure("");
    setCommonConfigDraft({
      description: field.comment || field.key,
      field,
      value: field.value,
    });
  }

  async function saveCommonConfig() {
    if (!commonConfigDraft || profileMutationInFlight.current) return;
    const description = commonConfigDraft.description.trim();
    const value = commonConfigDraft.value;
    if (!description) {
      setCommonConfigFailure("请填写一个以后容易识别的说明");
      return;
    }
    if (!value.trim()) {
      setCommonConfigFailure("请填写配置值");
      return;
    }

    profileMutationInFlight.current = true;
    setSavingCommonConfig(true);
    setCommonConfigFailure("");
    const { field } = commonConfigDraft;
    const secret = isSecretVariable(field.key, secretVariables);
    try {
      const saved = await saveConfigProfile({
        id: commonConfigDraft.profileId,
        kind: "custom",
        provider: "environment",
        name: description,
        scope: "any",
        values: secret
          ? { env_name: field.key }
          : { env_name: field.key, env_value: value },
        secretFields: secret ? [field.key] : [],
        secrets: secret ? { [field.key]: value } : {},
        isDefault: profiles.length === 0,
      });
      const idsForOtherFields = boundProfileIds.filter((boundId) => {
        const profile = profiles.find((candidate) => candidate.id === boundId);
        return profile?.values.env_name !== field.key;
      });
      const nextProfileIds = Array.from(
        new Set([...idsForOtherFields, saved.id]),
      );
      try {
        await setEnvironmentConfigBindings(path, environment, nextProfileIds);
      } catch (error) {
        // The profile may already be safely stored. Keep its id so retrying the
        // dialog updates that same entry instead of creating duplicates.
        setCommonConfigDraft((current) =>
          current ? { ...current, profileId: saved.id } : current,
        );
        throw error;
      }

      setProfiles((current) => [
        ...current.filter((profile) => profile.id !== saved.id),
        saved,
      ]);
      setBoundProfileIds(nextProfileIds);
      setBindingRefreshPending(false);
      setContent((current) => replaceEnvLine(current, field.lineIndex, value));
      setCommonConfigDraft(null);
    } catch (error) {
      const message = toMessage(error);
      setCommonConfigFailure(message);
      onError(message);
    } finally {
      profileMutationInFlight.current = false;
      setSavingCommonConfig(false);
    }
  }

  const save = useCallback(
    async (overwriteLocal = false, automatic = false) => {
      if (missingRequired.length) {
        onErrorRef.current(
          `还有 ${missingRequired.length} 项${label}必填配置没有值`,
        );
        return;
      }
      setSaving(true);
      try {
        if (environment === "development") {
          const exported = await writeLocalEnv(path, content, overwriteLocal);
          if (exported.requiresConfirmation && !overwriteLocal) {
            if (!automatic) setConfirmOverwrite(true);
            return false;
          }
          await storeRuntimeConfig(path, environment, content);
        } else if (server) {
          await storeRuntimeConfig(path, environment, content);
          const synced = await syncRuntimeConfigToServer(
            path,
            environment,
            server,
          );
          if (!synced.synchronized) {
            throw new Error("配置已安全保存，但还没有同步到运行服务器");
          }
          skipNextRemoteCheck.current = true;
          setRemoteSynchronized(true);
          setRemoteCheckComplete(true);
        } else {
          await storeRuntimeConfig(path, environment, content);
        }
        setDocument((current) =>
          current ? { ...current, content, stored: true } : current,
        );
        onReadyChange?.(true, false);
        return true;
      } catch (error) {
        onErrorRef.current(toMessage(error));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [
      content,
      environment,
      label,
      missingRequired.length,
      onReadyChange,
      path,
      server,
    ],
  );

  useEffect(() => {
    if (!automaticSavePending) return;
    const key = automaticLocalSavePending
      ? automaticLocalSaveKey
      : automaticEmptySaveKey;
    automaticSaveAttempted.current = key;
    void save(false, true);
  }, [
    automaticEmptySaveKey,
    automaticLocalSaveKey,
    automaticLocalSavePending,
    automaticSavePending,
    save,
  ]);

  async function markOptional() {
    if (!pendingOptional || !onMarkOptional) return;
    setSaving(true);
    try {
      if (!(await onMarkOptional(pendingOptional.key))) return;
      setDocument((current) =>
        current
          ? {
              ...current,
              requiredVariables: current.requiredVariables.filter(
                (key) => key !== pendingOptional.key,
              ),
            }
          : current,
      );
      setPendingOptional(null);
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function reuseProjectSecrets() {
    setSaving(true);
    try {
      if (environment === "development") return;
      const local = await loadExistingProjectConfig(path, environment);
      const merged = mergeReusableLocalSecrets(
        content,
        local.content,
        secretVariables,
      );
      if (!merged.filledVariables.length) {
        onError("本机配置中没有可以安全补全的值");
        return;
      }
      setContent(merged.content);
      setDocument((current) =>
        current
          ? { ...current, authorizationRequired: false, stored: false }
          : current,
      );
    } catch (error) {
      onError(toMessage(error));
    } finally {
      setSaving(false);
    }
  }

  function autoFill() {
    const result = fillGeneratedInternalSecrets(content);
    if (!result.filledVariables.length) {
      onError("当前缺少的配置需要你选择已有连接或手动填写");
      return;
    }
    setContent(result.content);
  }

  if (loading) {
    return (
      <div className="flex min-h-28 items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--muted-foreground)]">
        <LoaderCircle className="animate-spin-slow" />
        正在读取{label}配置
      </div>
    );
  }

  if (loadFailure || !document) {
    return (
      <div
        className="rounded-lg border border-[var(--warning)]/35 bg-[var(--warning-soft)] px-4 py-4"
        role="alert"
      >
        <strong className="block text-sm">暂时无法读取{label}配置</strong>
        <p className="mb-3 mt-1 text-xs leading-5 text-[var(--muted-foreground)]">
          为避免覆盖原有配置，本页已停止保存。重新读取成功后才能继续修改。
        </p>
        {loadFailure ? (
          <code className="mb-3 block break-all text-[11px] text-[var(--muted-foreground)]">
            {loadFailure}
          </code>
        ) : null}
        <Button
          onClick={() => void refresh(false)}
          size="sm"
          variant="secondary"
        >
          <RefreshCw />
          重新读取
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-4 py-3">
          <div>
            <strong className="text-sm font-medium">{heading}</strong>
            <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
              {usesVerifiedRemoteConfig
                ? "配置已在运行服务器准备好"
                : document?.authorizationRequired
                  ? "已保存的配置需要你确认后读取"
                  : fields.length === 0
                    ? checkingReady
                      ? "没有需要填写的配置，正在自动准备"
                      : checksRemoteServer && !ready
                        ? environment === "production"
                          ? "无需填写，使用当前配置即可"
                          : "没有需要填写的配置，等待同步到运行服务器"
                        : checksRemoteServer
                          ? "项目默认设置已经准备"
                          : "这个项目不需要额外配置"
                    : missingRequired.length
                      ? `${missingRequired.length} 项必填配置没有值`
                      : missing.length
                        ? `必填项已齐全，另有 ${missing.length} 项可选配置未填写`
                        : checkingRemoteSync
                          ? "正在确认运行服务器中的配置"
                          : checksRemoteServer &&
                              document?.stored &&
                              !remoteSynchronized
                            ? "配置已保存在本机，需要同步到运行服务器"
                            : ready
                              ? checksRemoteServer
                                ? "配置已保存到运行服务器"
                                : "配置已保存到本机"
                              : "配置项已经齐全，等待保存"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {boundProfileIds.length ? (
              <span className="text-xs text-[var(--muted-foreground)]">
                引用配置中心 {boundProfileIds.length} 项
              </span>
            ) : null}
            {ready ? (
              <span className="flex items-center gap-1.5 text-xs text-[var(--success)]">
                <CheckCircle2 className="size-4" />
                {checksRemoteServer ? "已准备" : "已保存"}
              </span>
            ) : null}
          </div>
        </div>

        {usesVerifiedRemoteConfig ? (
          <div className="flex items-center justify-between gap-4 border-b border-[var(--success)]/20 bg-[var(--success-soft)] px-4 py-3">
            <div>
              <strong className="text-sm font-medium">可以继续部署</strong>
              <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
                运行服务器仍在使用上次确认的配置；只有查看或修改敏感值时才需要系统确认。
              </p>
            </div>
            <Button
              onClick={() => void refresh(true)}
              size="sm"
              variant="secondary"
            >
              查看或修改配置
            </Button>
          </div>
        ) : document?.authorizationRequired ? (
          <div className="flex items-center justify-between gap-4 border-b border-[var(--warning)]/25 bg-[var(--warning-soft)] px-4 py-3">
            <div>
              <strong className="text-sm font-medium">
                已保存配置需要确认
              </strong>
              <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
                系统不会在应用启动时弹出授权；需要使用旧配置时再确认一次即可。
              </p>
            </div>
            <Button
              onClick={() => void refresh(true)}
              size="sm"
              variant="secondary"
            >
              读取已保存配置
            </Button>
          </div>
        ) : null}

        {bindingRefreshPending && !document.authorizationRequired ? (
          <div className="flex items-center justify-between gap-4 border-b border-[var(--accent)]/20 bg-[var(--info-soft)] px-4 py-3">
            <div>
              <strong className="text-sm font-medium">
                配置中心有已引用的敏感值
              </strong>
              <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
                应用启动时不会自动读取系统密钥库；需要刷新引用时再确认即可。
              </p>
            </div>
            <Button
              disabled={applyingProfile}
              onClick={() => void refreshBoundProfileValues()}
              size="sm"
              variant="secondary"
            >
              {applyingProfile ? (
                <LoaderCircle className="animate-spin-slow" />
              ) : (
                <KeyRound />
              )}
              {applyingProfile ? "正在读取" : "读取引用配置"}
            </Button>
          </div>
        ) : null}

        {bindingFailure ? (
          <div
            className="flex items-center justify-between gap-4 border-b border-[var(--warning)]/25 bg-[var(--warning-soft)] px-4 py-3"
            role="alert"
          >
            <div>
              <strong className="text-sm font-medium">
                配置中心引用暂时没有恢复
              </strong>
              <p className="mb-0 mt-1 text-xs text-[var(--muted-foreground)]">
                当前运行配置没有被覆盖。可以重试，或取消引用后手动填写。
              </p>
            </div>
            <Button
              disabled={applyingProfile}
              onClick={() => void refresh(false)}
              size="sm"
              variant="secondary"
            >
              重新检查
            </Button>
          </div>
        ) : null}

        {visibleFields.length ? (
          visibleFields.map((field) => {
            const secret = isSecretVariable(field.key, secretVariables);
            const candidates = profiles.filter(
              (profile) => profile.values.env_name === field.key,
            );
            const selectedProfile = candidates.find((profile) =>
              boundProfileIds.includes(profile.id),
            );
            const inputId = `${environment}-${field.key}`;
            return (
              <div
                className="border-b border-[var(--border)] px-4 py-4 last:border-b-0"
                key={field.key}
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div>
                    <Label htmlFor={inputId}>
                      {field.comment || field.key}
                    </Label>
                    {field.comment ? (
                      <code className="mt-1 block text-[11px] text-[var(--muted-foreground)]">
                        配置名称：{field.key}
                      </code>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[var(--subtle-foreground)]">
                      {field.required ? "必填" : "可选"}
                    </span>
                    {field.required && !field.value.trim() && onMarkOptional ? (
                      <Button
                        onClick={() => setPendingOptional(field)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        项目不需要
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <div className="relative min-w-[260px] flex-1">
                    <Input
                      className={secret ? "pr-10" : undefined}
                      id={inputId}
                      onChange={(event) =>
                        updateValue(field, event.target.value)
                      }
                      placeholder={runtimeFieldPlaceholder(
                        field.key,
                        environment,
                      )}
                      readOnly={Boolean(selectedProfile)}
                      type={
                        secret && !showSecrets[field.key] ? "password" : "text"
                      }
                      value={field.value}
                    />
                    {secret ? (
                      <Button
                        aria-label={`${showSecrets[field.key] ? "隐藏" : "显示"}${field.comment || field.key}配置值`}
                        className="absolute right-0 top-0"
                        onClick={() =>
                          setShowSecrets((current) => ({
                            ...current,
                            [field.key]: !current[field.key],
                          }))
                        }
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        {showSecrets[field.key] ? <EyeOff /> : <Eye />}
                      </Button>
                    ) : null}
                  </div>
                  {candidates.length ? (
                    <Select
                      disabled={applyingProfile}
                      onValueChange={(value) => void useProfile(field, value)}
                      value={selectedProfile?.id ?? "__manual__"}
                    >
                      <SelectTrigger
                        aria-label={`${field.key} 使用配置中心已有值`}
                      >
                        <SelectValue placeholder="使用配置中心已有值" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__manual__">手动填写</SelectItem>
                        {candidates.map((profile) => (
                          <SelectItem key={profile.id} value={profile.id}>
                            {profile.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  {!selectedProfile ? (
                    <Button
                      disabled={applyingProfile || savingCommonConfig}
                      onClick={() => openCommonConfig(field)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      {field.value.trim()
                        ? "保存为常用配置"
                        : candidates.length
                          ? "新增常用配置"
                          : "添加常用配置"}
                    </Button>
                  ) : null}
                </div>
                {!field.value.trim() ? (
                  <RuntimeFieldHint
                    environment={environment}
                    variable={field.key}
                  />
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="flex min-h-20 items-center gap-2 px-4 text-sm text-[var(--muted-foreground)]">
            {fields.length === 0 && checkingReady ? (
              <LoaderCircle className="size-4 animate-spin-slow" />
            ) : (
              <CheckCircle2 className="size-4 text-[var(--success)]" />
            )}
            {usesVerifiedRemoteConfig
              ? "当前配置可以继续使用"
              : document?.authorizationRequired
                ? "确认后显示已保存配置"
                : fields.length === 0
                  ? ready
                    ? "不需要额外操作"
                    : environment === "production"
                      ? "系统会保留项目默认设置"
                      : "没有需要你填写的配置"
                  : ready
                    ? "需要核对时可以查看全部配置"
                    : "没有缺失项，需要核对时可查看全部配置"}
          </div>
        )}

        {!usesVerifiedRemoteConfig &&
        (fields.length > 0 || (!ready && !checkingReady)) ? (
          <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--muted)]/35 px-4 py-3">
            <div className="flex gap-2">
              {fields.length > 0 ? (
                <Button
                  onClick={() => setShowAll((current) => !current)}
                  size="sm"
                  variant="ghost"
                >
                  {showAll ? "只看没有值的配置" : "查看全部配置"}
                </Button>
              ) : null}
              {environment !== "development" && hasReusableProjectConfig ? (
                <Button
                  disabled={saving}
                  onClick={() => void reuseProjectSecrets()}
                  size="sm"
                  variant="secondary"
                >
                  <KeyRound />
                  从本机配置补全
                </Button>
              ) : null}
              {hasGeneratableSecret && !document?.authorizationRequired ? (
                <Button
                  disabled={saving}
                  onClick={autoFill}
                  size="sm"
                  variant="secondary"
                >
                  <Sparkles />
                  自动补全
                </Button>
              ) : null}
            </div>
            {!ready ? (
              <Button
                disabled={
                  saving ||
                  applyingProfile ||
                  checkingRemoteSync ||
                  Boolean(missingRequired.length) ||
                  Boolean(document?.authorizationRequired)
                }
                onClick={() => void save()}
                size="sm"
              >
                {saving || checkingRemoteSync ? (
                  <LoaderCircle className="animate-spin-slow" />
                ) : (
                  <Save />
                )}
                {fields.length === 0
                  ? saving
                    ? `正在准备${label}环境`
                    : document?.stored
                      ? `重新同步${label}配置`
                      : environment === "production"
                        ? "使用当前配置并继续"
                        : `准备${label}配置`
                  : checkingRemoteSync
                    ? `正在确认${label}配置`
                    : needsRemoteSync
                      ? `${saving ? "正在同步" : "同步"}${label}配置`
                      : `${saving ? "正在保存" : "保存"}${label}配置`}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <Dialog onOpenChange={setConfirmOverwrite} open={confirmOverwrite}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>更新项目现有的 .env？</DialogTitle>
            <DialogDescription>
              项目中已经存在 .env。ABCDeploy
              会先创建备份，再写入你刚刚确认的本机配置。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirmOverwrite(false)}
              variant="secondary"
            >
              暂不更新
            </Button>
            <Button
              onClick={() => {
                setConfirmOverwrite(false);
                void save(true);
              }}
            >
              备份并更新
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => !open && setPendingOptional(null)}
        open={Boolean(pendingOptional)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认项目不需要这项配置？</DialogTitle>
            <DialogDescription>
              只有确认项目不会读取
              {pendingOptional?.comment || pendingOptional?.key}
              时才能继续。判断错误可能导致服务启动失败。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setPendingOptional(null)}
              variant="secondary"
            >
              取消
            </Button>
            <Button disabled={saving} onClick={() => void markOptional()}>
              {saving ? <LoaderCircle className="animate-spin-slow" /> : null}
              确认不需要
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => {
          if (!open && !savingCommonConfig) {
            setCommonConfigDraft(null);
            setCommonConfigFailure("");
          }
        }}
        open={Boolean(commonConfigDraft)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {commonConfigDraft?.field.value.trim()
                ? "保存为常用配置"
                : "添加常用配置"}
            </DialogTitle>
            <DialogDescription>
              保存后，当前{label}
              环境会立即使用这项配置。以后其他项目遇到相同配置名称时，也可以直接选择。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-2">
              <Label htmlFor="common-config-key">配置名称</Label>
              <Input
                id="common-config-key"
                readOnly
                value={commonConfigDraft?.field.key ?? ""}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="common-config-description">说明</Label>
              <Input
                id="common-config-description"
                onChange={(event) =>
                  setCommonConfigDraft((current) =>
                    current
                      ? { ...current, description: event.target.value }
                      : current,
                  )
                }
                placeholder="例如：公司统一短信服务令牌"
                value={commonConfigDraft?.description ?? ""}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="common-config-value">值</Label>
              <Input
                id="common-config-value"
                onChange={(event) =>
                  setCommonConfigDraft((current) =>
                    current
                      ? { ...current, value: event.target.value }
                      : current,
                  )
                }
                type={
                  commonConfigDraft &&
                  isSecretVariable(commonConfigDraft.field.key, secretVariables)
                    ? "password"
                    : "text"
                }
                value={commonConfigDraft?.value ?? ""}
              />
            </div>
            {commonConfigFailure ? (
              <p
                className="mb-0 rounded-md bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--warning-foreground)]"
                role="alert"
              >
                {commonConfigFailure}。当前内容和原有引用均未改变。
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              disabled={savingCommonConfig}
              onClick={() => {
                setCommonConfigDraft(null);
                setCommonConfigFailure("");
              }}
              variant="secondary"
            >
              取消
            </Button>
            <Button
              disabled={savingCommonConfig}
              onClick={() => void saveCommonConfig()}
            >
              {savingCommonConfig ? (
                <LoaderCircle className="animate-spin-slow" />
              ) : (
                <Save />
              )}
              {savingCommonConfig ? "正在保存" : "保存并使用"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function parseEnvFields(
  content: string,
  requiredVariables: string[],
): EnvField[] {
  const required = new Set(requiredVariables);
  const lines = content.split("\n");
  const fields: EnvField[] = [];
  let comments: string[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      comments.push(trimmed.replace(/^#+\s?/, "").trim());
      continue;
    }
    const match = line.match(
      /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/,
    );
    if (match) {
      fields.push({
        comment: comments.filter(Boolean).join(" "),
        key: match[1],
        lineIndex,
        required: required.has(match[1]),
        value: parseDotenvValue(match[2]),
      });
      comments = [];
      continue;
    }
    if (trimmed) comments = [];
  }
  return fields;
}

export function mergeReusableLocalSecrets(
  targetContent: string,
  localContent: string,
  secretVariables: string[],
) {
  const reusable = new Set(secretVariables);
  const localValues = new Map(
    parseEnvFields(localContent, []).map((field) => [field.key, field.value]),
  );
  let content = targetContent;
  const filledVariables: string[] = [];
  for (const field of parseEnvFields(content, [])) {
    const value = localValues.get(field.key) ?? "";
    if (
      field.value.trim() ||
      (isSecretVariable(field.key, []) &&
        reusable.size > 0 &&
        !reusable.has(field.key)) ||
      !reusableAcrossEnvironments(field.key, value)
    ) {
      continue;
    }
    content = replaceEnvLine(content, field.lineIndex, value);
    filledVariables.push(field.key);
  }
  return { content, filledVariables };
}

export function fillDeploymentRuntimeDefaults(
  content: string,
  environment: RuntimeEnvironment,
) {
  if (environment === "development") return content;
  let next = content;
  for (const field of parseEnvFields(next, [])) {
    if (
      field.value.trim() ||
      ![
        "VITE_API_BASE_URL",
        "NEXT_PUBLIC_API_BASE_URL",
        "NUXT_PUBLIC_API_BASE_URL",
        "PUBLIC_API_BASE_URL",
      ].includes(field.key)
    ) {
      continue;
    }
    next = replaceEnvLine(next, field.lineIndex, "/api");
  }
  return next;
}

function reusableAcrossEnvironments(key: string, value: string) {
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    normalized.includes("localhost") ||
    normalized.includes("127.0.0.1")
  )
    return false;
  return reusableVariableAcrossEnvironments(key);
}

export function reusableVariableAcrossEnvironments(key: string) {
  const upper = key.toUpperCase();
  return ![
    "NODE_ENV",
    "APP_ENV",
    "ENV",
    "DATABASE_URL",
    "REDIS_URL",
    "JWT_SECRET",
    "AUTH_TOKEN_SECRET",
    "SESSION_SECRET",
    "COOKIE_SECRET",
    "ENCRYPTION_KEY",
    "SECRET_KEY",
  ].includes(upper);
}

export function fillGeneratedInternalSecrets(content: string) {
  let next = content;
  const filledVariables: string[] = [];
  for (const field of parseEnvFields(next, [])) {
    if (field.value.trim() || !internalRuntimeSecret(field.key)) continue;
    next = replaceEnvLine(next, field.lineIndex, generateSecretValue());
    filledVariables.push(field.key);
  }
  return { content: next, filledVariables };
}

function internalRuntimeSecret(key: string) {
  return [
    "JWT_SECRET",
    "AUTH_TOKEN_SECRET",
    "SESSION_SECRET",
    "COOKIE_SECRET",
    "ENCRYPTION_KEY",
    "SECRET_KEY",
  ].some((suffix) => key === suffix || key.endsWith(`_${suffix}`));
}

function abcDeployManagedVariable(key: string) {
  return key === "DEPLOYDESK_ENV" || key.startsWith("DEPLOYDESK_");
}

function generateSecretValue() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function replaceEnvLine(content: string, lineIndex: number, value: string) {
  const lines = content.split("\n");
  const current = lines[lineIndex] ?? "";
  const assignment = current.match(
    /^(\s*(?:export\s+)?[A-Z_][A-Z0-9_]*\s*=\s*).*/,
  )?.[1];
  if (assignment) lines[lineIndex] = `${assignment}${formatDotenvValue(value)}`;
  return lines.join("\n");
}

function parseDotenvValue(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatDotenvValue(value: string) {
  return /^[A-Za-z0-9_./:@+-]*$/.test(value) ? value : JSON.stringify(value);
}

function isReusableVariable(profile: ConfigProfile) {
  return profile.kind === "custom" && Boolean(profile.values.env_name);
}

function profileHasProtectedValue(profile: ConfigProfile) {
  const variable = profile.values.env_name;
  return Boolean(variable && profile.configuredSecretFields.includes(variable));
}

function profileProvidesEnvironmentValue(profile: ConfigProfile) {
  const variable = profile.values.env_name;
  return Boolean(
    variable &&
    (profile.values.env_value?.trim() ||
      profile.configuredSecretFields.includes(variable)),
  );
}

function clearProfileBoundValues(
  content: string,
  profiles: ConfigProfile[],
  profileIds: string[],
) {
  const variables = new Set(
    profiles
      .filter(
        (profile) =>
          profileIds.includes(profile.id) &&
          profileProvidesEnvironmentValue(profile),
      )
      .map((profile) => profile.values.env_name)
      .filter(Boolean),
  );
  let next = content;
  for (const field of parseEnvFields(next, [])) {
    if (variables.has(field.key)) {
      next = replaceEnvLine(next, field.lineIndex, "");
    }
  }
  return next;
}

function isSecretVariable(key: string, knownSecrets: string[]) {
  return (
    knownSecrets.includes(key) ||
    /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)$/i.test(key)
  );
}

function RuntimeFieldHint({
  environment,
  variable,
}: {
  environment: RuntimeEnvironment;
  variable: string;
}) {
  if (environment === "development") return null;
  const label = environmentLabel(environment);
  if (variable === "DATABASE_URL") {
    return (
      <p className="mb-0 mt-2 text-xs text-[var(--muted-foreground)]">
        系统会在服务器自动准备{label}数据库；如需外部数据库，也可以手动填写
      </p>
    );
  }
  if (variable === "REDIS_URL") {
    return (
      <p className="mb-0 mt-2 text-xs text-[var(--muted-foreground)]">
        系统会在服务器自动准备{label} Redis；如需外部 Redis，也可以手动填写
      </p>
    );
  }
  if (/(_URL|_URI|_HOST|_DOMAIN)$/i.test(variable)) {
    return (
      <p className="mb-0 mt-2 text-xs text-[var(--muted-foreground)]">
        填写部署后可访问的地址，不能使用 localhost
      </p>
    );
  }
  return null;
}

function runtimeFieldPlaceholder(
  variable: string,
  environment: RuntimeEnvironment,
) {
  if (environment !== "development") {
    if (variable === "DATABASE_URL" || variable === "REDIS_URL") {
      return "由系统自动准备（可选覆盖）";
    }
    if (/(_URL|_URI|_HOST|_DOMAIN)$/i.test(variable)) {
      return "输入部署后的地址";
    }
  }
  return "输入配置值";
}

function managedRemoteDependency(
  environment: RuntimeEnvironment,
  variable: string,
) {
  return (
    environment !== "development" &&
    (variable === "DATABASE_URL" || variable === "REDIS_URL")
  );
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
