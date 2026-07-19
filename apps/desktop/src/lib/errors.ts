import type { ProviderCheck, UserFacingIssue } from "../types";

const CODE_PATTERN = /(AD-[A-Z]+-\d{3})[：:]\s*([\s\S]+)$/;
const CNB_SCOPE_PATTERN = /\b(?:repo|group)-[a-z0-9-]+:(?:r|rw)\b/g;

function hasOnlyMissingCnbScope(message: string, scope: string): boolean {
  const scopes = Array.from(new Set(message.match(CNB_SCOPE_PATTERN) ?? []));
  return scopes.length === 1 && scopes[0] === scope;
}

export function issueFromProvider(
  check: ProviderCheck,
  title = "无法准备目标服务器",
): UserFacingIssue {
  const code = check.code ?? "AD-SRV-299";
  const normalizedTitle = titleForCode(code, check.summary);
  const normalizedMessage = messageForCode(code, check.summary);
  const translated =
    Boolean(normalizedTitle) || normalizedMessage !== check.summary;
  return {
    code,
    title: normalizedTitle ?? title,
    message: normalizedMessage,
    nextSteps: translated
      ? nextStepsForCode(code, check.summary)
      : check.nextSteps?.length
        ? check.nextSteps
        : ["展开技术详情确认原因，处理后点击重新检查并继续"],
    technicalDetails: [
      ...(normalizedMessage !== check.summary ? [check.summary] : []),
      ...check.details,
    ],
    retryable: check.retryable ?? true,
  };
}

export function issueFromUnknown(
  error: unknown,
  title = "操作没有完成",
): UserFacingIssue {
  if (isUserFacingIssue(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  const coded = message.match(CODE_PATTERN);
  const displayMessage = coded?.[2] ?? message;
  const userMessage = messageForCode(coded?.[1], displayMessage);
  return {
    code: coded?.[1] ?? "AD-APP-001",
    title: titleForCode(coded?.[1], displayMessage) ?? title,
    message: userMessage,
    nextSteps: nextStepsForCode(coded?.[1], displayMessage),
    technicalDetails: coded
      ? userMessage === displayMessage
        ? []
        : [displayMessage]
      : [message],
    retryable: true,
  };
}

function messageForCode(code: string | undefined, original: string) {
  if (code === "AD-LOC-112") {
    if (original.includes("项目代码没有通过容器构建"))
      return "项目代码没有成功生成可在本机运行的版本。";
    return original
      .replace(/容器构建/g, "本机运行版本生成")
      .replace(/镜像构建/g, "本机运行版本生成");
  }
  if (
    code === "AD-CNB-103" &&
    hasOnlyMissingCnbScope(original, "repo-cnb-history:r")
  )
    return "已经完成的部署步骤仍然保留。请同时检查令牌的授权范围和使用范围。";
  const messages: Record<string, string> = {
    "AD-GIT-101":
      "项目里还有尚未加入代码版本的改动。为了避免发布旧内容，系统已经暂停。",
    "AD-GIT-102": "代码平台上的部署记录已经更新，系统没有覆盖远端内容。",
    "AD-GIT-103": "当前选择的文件夹只是更大项目的一部分。",
    "AD-GIT-104": "当前文件夹中没有识别到可以发布的项目代码。",
    "AD-CTR-101": "系统没有识别出这个服务的可靠运行方式。",
    "AD-CNB-101": "CNB 登录已经失效，当前部署任务和已完成步骤仍然保留。",
    "AD-CNB-103": "代码平台授权还不完整，已经完成的部署步骤仍然保留。",
    "AD-CNB-108":
      "系统密钥库暂时无法读取已保存的 CNB 授权，项目和部署任务不受影响。",
    "AD-CNB-203":
      "系统暂时没有从代码平台取得最新进度，当前任务和已完成步骤仍然保留。",
    "AD-CNB-204":
      "系统暂时没有从代码平台取得最新进度，当前任务和已完成步骤仍然保留。",
    "AD-BLD-201":
      "代码平台没有生成可部署的项目版本，服务器上的现有版本没有变化。",
    "AD-DEP-201": "项目版本已经生成，但服务器没有完成本次更新。",
    "AD-REL-101": "应用已经部署到服务器，但系统还没有核对出本次实际版本。",
    "AD-REL-201": "测试服务可以运行，但系统还没有取得用于安全发布的版本证据。",
    "AD-CTR-201": "项目已经部署到服务器，但至少一个服务没有通过启动检查。",
    "AD-CACHE-201": "当前环境的项目服务暂时无法连接缓存服务。",
    "AD-SSH-105": "运行服务器还没有接受这台电脑的安全连接。",
    "AD-SSH-106": "运行服务器没有完成安全连接设置。",
    "AD-SSH-201": "系统无法使用已保存的登录信息连接运行服务器。",
    "AD-SRV-203":
      "服务器上的统一访问入口没有运行，项目服务暂时无法通过域名打开。",
    "AD-SRV-202": "服务器上已有访问服务，但还不能安全接入新的项目地址。",
    "AD-SRV-204": "项目服务已经准备，但服务器访问入口还没有配置完成。",
    "AD-SRV-205": "项目服务已经准备，但服务器访问入口还没有配置完成。",
    "AD-SRV-206": "服务器上已有访问规则使用相同地址，当前版本尚未切换。",
    "AD-SRV-207": "新的访问地址没有加载成功，系统已经保留上一次可用配置。",
    "AD-SRV-209": "项目服务仍在运行，但正式访问地址没有加载到服务器。",
    "AD-SRV-210": "这个访问地址已经由另一条上线线路使用，系统没有覆盖它。",
    "AD-SRV-211": "项目服务已经运行，但统一访问入口还没有连接到项目服务。",
    "AD-SRV-212": "服务器暂时无法下载统一访问组件。",
    "AD-IMG-201": "运行服务器暂时无法读取本次项目版本。",
    "AD-IMG-202": "系统暂时无法验证已填写的版本仓库登录信息。",
    "AD-REG-101": "项目版本保存位置还缺少必要信息。",
    "AD-REG-102": "项目版本保存位置没有接受这组登录信息。",
    "AD-REG-103": "系统暂时没有完成项目版本保存位置的登录验证。",
    "AD-SSH-101": "这台电脑用于连接服务器的安全身份文件不存在。",
    "AD-SSH-102": "系统暂时无法连接运行服务器。",
    "AD-SSH-103": "服务器身份与上次记录不同，系统已经停止连接。",
    "AD-LOC-103": "本机配置可能已经被加入代码版本，其中可能包含真实密钥。",
    "AD-LOC-104": "本机配置还没有保存，项目暂时无法启动。",
    "AD-LOC-106": "本机运行环境还没有准备好。",
    "AD-LOC-111": "系统没有识别出全部项目服务的可靠运行方式。",
    "AD-LOC-113": "至少一个本机服务没有正常启动。",
    "AD-LOC-117": "下载或准备本机运行组件长时间没有进展，已经自动停止。",
    "AD-INF-101": "本机运行环境还没有准备好。",
    "AD-INF-102": "系统没有完成本机运行依赖的下载。",
    "AD-INF-104": "本机数据库没有正常启动。",
    "AD-INF-105": "本机缓存服务没有正常启动。",
    "AD-INF-202": "服务器暂时无法下载项目运行所需的基础组件。",
    "AD-INF-203": "服务器数据库没有正常运行。",
    "AD-INF-204": "服务器缓存服务没有正常运行。",
  };
  return (code && messages[code]) || original;
}

function nextStepsForCode(code?: string, message = ""): string[] {
  if (code === "AD-GIT-101")
    return ["让编程工具把当前改动加入代码版本，或选择“部署已提交版本”"];
  if (code === "AD-GIT-102")
    return ["让编程工具安全同步代码平台上的项目主分支；不要强制覆盖现有内容"];
  if (code === "AD-GIT-103")
    return ["重新添加项目，并选择包含整个项目的最外层文件夹"];
  if (code === "AD-GIT-104")
    return ["确认所选文件夹中有项目代码，然后重新添加项目"];
  if (code === "AD-CTR-101")
    return ["把提示交给开发工具，补齐这个服务的可靠运行方式"];
  if (code === "AD-SYS-101") return ["重新点击复制；仍失败时重新启动客户端"];
  if (code === "AD-SYS-102")
    return ["配置已经复制，请在浏览器中手动打开 cnb.cool"];
  if (code === "AD-CNB-101")
    return ["重新连接 CNB，保存成功后回到当前任务继续"];
  if (code === "AD-CNB-102") return ["检查网络能否访问 cnb.cool，然后重新尝试"];
  if (
    code === "AD-CNB-103" &&
    hasOnlyMissingCnbScope(message, "repo-cnb-history:r")
  )
    return [
      "在授权范围勾选“读取构建记录”（repo-cnb-history:r），并确认使用范围包含当前仓库或全部仓库",
    ];
  if (
    code === "AD-CNB-103" &&
    hasOnlyMissingCnbScope(message, "repo-cnb-trigger:rw")
  )
    return ["更新 CNB 授权并勾选“触发自动构建”，然后重新部署"];
  if (code === "AD-CNB-103")
    return [
      "按连接页勾选全部 6 项 CNB 权限（包括读取构建详情），并确认使用范围包含当前仓库或全部仓库",
    ];
  if (code === "AD-CNB-104")
    return ["返回 CNB 连接步骤刷新组织；没有组织时先在 CNB 创建组织"];
  if (code === "AD-CNB-105")
    return ["选择已有 CNB 组织，并使用字母、数字、点、横线或下划线命名"];
  if (code === "AD-CNB-106")
    return ["在 CNB 网页确认同名仓库权限，或选择另一个仓库名"];
  if (code === "AD-CNB-107") return ["等待一分钟，再重新点击自动准备"];
  if (code === "AD-CNB-108")
    return ["重新打开应用；仍未恢复时再粘贴并保存新的 CNB 令牌"];
  if (code === "AD-CNB-199")
    return ["重新连接 CNB 后再试；仍失败时查看技术详情"];
  if (code === "AD-CNB-201")
    return [
      "按当前页面复制配置并在 CNB 保存，回到客户端后点击“我已在网页保存”",
    ];
  if (code === "AD-CNB-202")
    return ["点击“重新部署”或“重新发布”；系统会继续使用当前已确认版本"];
  if (code === "AD-CNB-203" || code === "AD-CNB-204")
    return ["检查 CNB 网络和构建记录读取权限；返回客户端后系统会自动确认进度"];
  if (code === "AD-BLD-201")
    return ["复制脱敏后的构建原因交给编程工具修复，提交代码后重新部署测试版"];
  if (code === "AD-PKG-201")
    return ["点击“检查后重新部署”；系统会自动补齐依赖锁定文件并继续"];
  if (code === "AD-PKG-202")
    return ["确认电脑可以访问依赖源，然后重试；无需手动修改部署文件"];
  if (code === "AD-DEP-201")
    return ["查看失败阶段；修复服务器连接或运行配置后从当前版本重试"];
  if (code === "AD-REL-201")
    return ["重新验证目标服务器连接；返回部署页面后系统会自动核对版本"];
  if (code === "AD-REL-101")
    return ["重新检查服务器上的实际版本；无需重新生成项目版本"];
  if (code === "AD-REL-204")
    return ["先部署并验证包含新增服务的测试版本，再重新发布正式版"];
  if (code === "AD-REL-301") return ["重新部署测试环境，再发布新的已验证候选"];
  if (code === "AD-CTR-201")
    return ["让 ABCDeploy 检查服务启动日志，再按提示处理端口、依赖或健康检查"];
  if (code === "AD-CTR-202" || code === "AD-WEB-201")
    return ["让 ABCDeploy 重新生成部署文件，然后重新部署当前代码版本"];
  if (code === "AD-APP-201")
    return ["把提示的缺失依赖交给编程工具补齐，提交代码后重新部署"];
  if (code === "AD-APP-202")
    return ["让编程工具调整项目监听端口，保存后重新部署测试版"];
  if (code === "AD-CFG-201")
    return ["按提示在当前环境的安全配置中补齐字段，保存后从当前步骤重试"];
  if (code === "AD-DB-201")
    return ["检查当前环境的数据库账号和密码，重新保存配置后继续"];
  if (code === "AD-DB-202")
    return ["确认数据库正在运行且服务器可以访问，然后重新部署"];
  if (code === "AD-DB-203" || code === "AD-DB-204")
    return ["重新生成当前环境的远程安全配置，保存后从失败步骤继续"];
  if (code === "AD-CACHE-201")
    return ["确认缓存服务正在运行且服务器可以访问，重新保存配置后继续"];
  if (code === "AD-SSH-105")
    return ["确认服务器登录用户和密码，然后重新自动建立安全连接"];
  if (code === "AD-SSH-101")
    return ["返回服务器连接，重新选择或生成这台电脑的安全身份"];
  if (code === "AD-SSH-102")
    return ["检查服务器地址、公网访问规则和登录信息，然后重新连接"];
  if (code === "AD-SSH-103")
    return ["确认服务器是否重装或更换；核实无误后重新建立信任"];
  if (code === "AD-SSH-106")
    return ["确认服务器登录用户可以保存安全身份，然后重试"];
  if (code === "AD-SSH-201")
    return ["返回上线设置重新连接服务器，并更新测试环境的安全登录信息"];
  if (code === "AD-SRV-208")
    return ["清理目标服务器磁盘空间，确认服务器运行环境可用后从当前步骤重试"];
  if (code === "AD-SRV-203")
    return ["重新准备服务器上的统一访问服务，然后只检查访问地址"];
  if (code === "AD-SRV-202")
    return ["让系统为现有访问服务准备独立项目路由，然后重新检查"];
  if (code === "AD-SRV-204" || code === "AD-SRV-205")
    return ["重新检查运行服务器，让系统修复统一访问配置后继续"];
  if (code === "AD-SRV-206")
    return ["确认页面列出的地址是否可以切换；系统会先备份，失败时自动恢复"];
  if (code === "AD-SRV-207")
    return ["重新应用访问地址；系统已保留并恢复上一次可用配置"];
  if (code === "AD-SRV-209")
    return ["点击“重新应用地址”；系统只修复访问入口，不会重新生成项目版本"];
  if (code === "AD-SRV-210")
    return ["修改当前线路的访问地址，或先处理占用该地址的项目，再继续上线"];
  if (code === "AD-SRV-211")
    return ["点击“继续上线”，系统会重新连接访问入口，不会重新生成项目版本"];
  if (code === "AD-SRV-212")
    return [
      "检查服务器能否访问公网，然后重新初始化；系统会自动切换国内镜像来源",
    ];
  if (code === "AD-IMG-201")
    return [
      "重新检查项目版本保存位置的账号和服务器读取权限，然后从当前步骤重试",
    ];
  if (code === "AD-IMG-202")
    return ["确认 Docker Desktop 和本机网络可用，然后重新验证项目版本保存位置"];
  if (code === "AD-REG-101")
    return ["回到项目版本保存位置，补全页面要求的地址和项目空间"];
  if (code === "AD-REG-102") return ["重新获取登录用户名和访问密码，然后再试"];
  if (code === "AD-REG-103")
    return ["确认 Docker Desktop 和本机网络可用，然后重新验证"];
  if (code === "AD-NET-201")
    return ["修正 DNS 或 HTTPS；回到客户端后系统会自动检查，无需重新构建"];
  if (code === "AD-NET-202")
    return ["确认本机网络可用；恢复后系统会自动继续检查，不会重新部署"];
  if (code === "AD-LOC-101") return ["重新选择项目目录，然后回到本地运行"];
  if (code === "AD-LOC-102") return ["检查本地配置文件后重新保存"];
  if (code === "AD-LOC-103")
    return ["把提示交给开发工具，停止把本机配置加入代码版本并清理真实密钥"];
  if (code === "AD-LOC-104") return ["补齐必要配置并点击“保存本机配置”"];
  if (code === "AD-LOC-106") return ["启动 Docker Desktop，等待就绪后重新尝试"];
  if (code === "AD-LOC-110")
    return ["确认电脑可以访问依赖源，然后重新启动本地预览"];
  if (code === "AD-LOC-111")
    return ["把提示复制给开发工具，补齐缺失服务的运行方式"];
  if (code === "AD-LOC-112")
    return ["点击“复制给开发工具”，修复项目代码后重新启动"];
  if (code === "AD-LOC-113")
    return ["查看没有正常启动的服务原因，修复后重新启动"];
  if (code === "AD-INF-101") return ["启动 Docker Desktop，等待就绪后重新尝试"];
  if (code === "AD-INF-102")
    return ["确认电脑可以下载安装运行依赖，然后重新尝试"];
  if (code === "AD-INF-103")
    return ["重新点击自动准备；仍失败时关闭占用本机端口的程序"];
  if (code === "AD-INF-104" || code === "AD-INF-105")
    return ["重新检查本机基础服务；仍失败时查看对应服务状态"];
  if (code === "AD-INF-106" || code === "AD-INF-107")
    return ["先点击“自动准备运行依赖”，完成后再控制单个服务"];
  if (code === "AD-INF-201" || code === "AD-INF-202")
    return code === "AD-INF-202"
      ? ["点击“继续上线”重试；系统会自动优先使用国内来源，无需修改项目配置"]
      : ["重新检查服务器连接和磁盘空间，然后再次保存远程配置"];
  if (code === "AD-INF-203" || code === "AD-INF-204")
    return ["检查服务器上的数据库或缓存状态，处理后重新生成远程配置"];
  if (code === "AD-LOC-105" || code === "AD-LOC-108")
    return ["确认 Docker Desktop 仍在运行，然后重新执行刚才的操作"];
  if (code === "AD-LOC-109")
    return ["打开 Docker Desktop 检查仍在运行的项目服务，然后再次停止"];
  if (code === "AD-LOC-114") return ["重新打开项目，让系统重新识别服务后再试"];
  if (code === "AD-LOC-115")
    return ["改用“稳定运行”；需要热更新时让编程工具补齐可靠的开发命令"];
  if (code === "AD-LOC-116")
    return ["关闭占用提示端口的其他程序，然后重新启动这个服务"];
  if (code === "AD-LOC-117")
    return [
      "确认 Docker Desktop 的网络或代理可用，然后重新启动；无需修改项目代码",
    ];
  if (code === "AD-LOC-118") return ["需要运行时，重新启动刚才的服务"];
  if (code === "AD-LOC-119")
    return ["等待当前启动完成，或点击“停止本次启动”后重新尝试"];
  if (code === "AD-LOC-120")
    return ["停止正在占用端口的本机项目，然后自动继续本次启动"];
  if (code === "AD-LOC-121")
    return ["回到占用端口的项目停止本机服务，然后重新启动当前项目"];
  return ["确认当前页面的检查项，处理后重新尝试"];
}

function titleForCode(code?: string, message = ""): string | undefined {
  if (code === "AD-GIT-101") return "项目改动还没有提交";
  if (code === "AD-GIT-102") return "部署分支需要先同步";
  if (code === "AD-GIT-103") return "请选择完整的项目文件夹";
  if (code === "AD-GIT-104") return "项目文件夹中没有代码";
  if (code === "AD-CTR-101") return "项目运行方式还需开发处理";
  if (code === "AD-SYS-101") return "配置没有复制成功";
  if (code === "AD-SYS-102") return "系统浏览器没有打开";
  if (code === "AD-CNB-101") return "需要重新连接 CNB";
  if (
    code === "AD-CNB-103" &&
    hasOnlyMissingCnbScope(message, "repo-cnb-history:r")
  )
    return "当前令牌不能读取这个仓库的构建记录";
  if (code === "AD-CNB-103") return "当前 CNB 授权无法完成这项操作";
  if (code === "AD-CNB-108") return "暂时无法读取已保存的 CNB 授权";
  if (code === "AD-CNB-201") return "还差一次远程安全配置";
  if (code === "AD-CNB-202") return "远程部署任务没有开始";
  if (code === "AD-CNB-203" || code === "AD-CNB-204")
    return "暂时无法读取部署进度";
  if (code === "AD-BLD-201") return "项目版本没有生成成功";
  if (code === "AD-PKG-201") return "项目依赖版本还没有锁定";
  if (code === "AD-PKG-202") return "依赖版本没有准备完成";
  if (code === "AD-DEP-201") return "服务器没有完成部署";
  if (code === "AD-REL-101") return "服务器版本还没有核对完成";
  if (code === "AD-REL-204") return "正式版还缺少新服务";
  if (code === "AD-CTR-201") return "服务没有正常启动";
  if (code === "AD-CTR-202" || code === "AD-WEB-201") return "部署文件需要更新";
  if (code === "AD-APP-201") return "项目缺少运行依赖";
  if (code === "AD-APP-202") return "项目端口发生冲突";
  if (code === "AD-CFG-201") return "运行配置还缺内容";
  if (code === "AD-DB-201") return "数据库账号或密码不正确";
  if (code === "AD-DB-202") return "暂时无法连接数据库";
  if (code === "AD-DB-203" || code === "AD-DB-204")
    return "远程数据库还没有准备好";
  if (code === "AD-CACHE-201") return "暂时无法连接缓存服务";
  if (code === "AD-SSH-105") return "服务器尚未接受安全身份";
  if (code === "AD-SSH-106") return "安全身份没有安装完成";
  if (code === "AD-SSH-201") return "服务器登录凭据已失效";
  if (code === "AD-SRV-208") return "服务器磁盘空间不足";
  if (code === "AD-SRV-202") return "服务器访问服务需要调整";
  if (code === "AD-SRV-203") return "统一访问服务没有运行";
  if (code === "AD-SRV-204" || code === "AD-SRV-205")
    return "服务器访问配置还没有准备好";
  if (code === "AD-SRV-206") return "访问地址正在被旧版本使用";
  if (code === "AD-SRV-207") return "访问地址没有重新加载成功";
  if (code === "AD-SRV-209") return "正式地址没有加载成功";
  if (code === "AD-SRV-210") return "访问地址已被其他项目使用";
  if (code === "AD-SRV-211") return "访问入口还没连到项目服务";
  if (code === "AD-SRV-212") return "服务器无法下载访问组件";
  if (code === "AD-IMG-201") return "项目版本无法读取";
  if (code === "AD-IMG-202") return "暂时无法验证项目版本保存位置";
  if (code === "AD-REG-101") return "项目版本保存位置还没有配置完整";
  if (code === "AD-REG-102") return "登录信息没有通过验证";
  if (code === "AD-REG-103") return "这次没有完成登录验证";
  if (code === "AD-SSH-101") return "服务器安全身份不可用";
  if (code === "AD-SSH-102") return "运行服务器暂时无法连接";
  if (code === "AD-SSH-103") return "服务器身份发生变化";
  if (code === "AD-NET-201") return "访问地址还没有准备好";
  if (code === "AD-NET-202") return "这次地址检查没有完成";
  if (code === "AD-LOC-103") return "项目可能会提交真实密钥";
  if (code === "AD-LOC-104") return "本机配置还没有保存";
  if (code === "AD-LOC-106") return "本机运行环境还没有准备好";
  if (code === "AD-LOC-110") return "项目依赖下载失败";
  if (code === "AD-LOC-111") return "项目运行方式还需开发处理";
  if (code === "AD-LOC-112") return "项目没有成功生成本机运行版本";
  if (code === "AD-LOC-113") return "本地服务没有全部启动";
  if (code === "AD-INF-101") return "本机运行环境还没有准备好";
  if (code === "AD-INF-102") return "本机运行依赖下载失败";
  if (code === "AD-INF-103") return "本机端口已被占用";
  if (code === "AD-INF-104" || code === "AD-INF-105")
    return "本机基础服务没有准备完成";
  if (code === "AD-INF-106" || code === "AD-INF-107")
    return "运行依赖还没有准备";
  if (code === "AD-INF-201" || code === "AD-INF-202")
    return "服务器运行依赖没有准备完成";
  if (code === "AD-INF-203" || code === "AD-INF-204")
    return "服务器基础服务没有正常运行";
  if (code === "AD-LOC-105" || code === "AD-LOC-108")
    return "本机服务操作意外中断";
  if (code === "AD-LOC-109") return "本机服务没有全部停止";
  if (code === "AD-LOC-114") return "项目服务已经发生变化";
  if (code === "AD-LOC-115") return "当前项目暂不支持开发调试";
  if (code === "AD-LOC-116") return "本机端口已被占用";
  if (code === "AD-LOC-117") return "运行组件下载长时间没有进展";
  if (code === "AD-LOC-118") return "本次启动已停止";
  if (code === "AD-LOC-119") return "项目已经在启动";
  if (code === "AD-LOC-120") return "另一个项目占用了本机端口";
  if (code === "AD-LOC-121") return "无法自动停止占用端口的项目";
  return undefined;
}

function isUserFacingIssue(value: unknown): value is UserFacingIssue {
  if (!value || typeof value !== "object") return false;
  const issue = value as Partial<UserFacingIssue>;
  return (
    typeof issue.code === "string" &&
    typeof issue.title === "string" &&
    typeof issue.message === "string" &&
    Array.isArray(issue.nextSteps) &&
    Array.isArray(issue.technicalDetails) &&
    typeof issue.retryable === "boolean"
  );
}
