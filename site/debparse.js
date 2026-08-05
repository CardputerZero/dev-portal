/**
 * Browser-side .deb inspector for the CardputerZero developer portal.
 *
 * Parses a Debian package entirely in the browser (no upload needed):
 *   ar archive -> control.tar{,.gz,.xz,.zst} + data.tar{,.gz,.xz,.zst,.bz2,.lzma}
 * (every compression the deb(5) format allows) and produces control fields,
 * the .desktop entry, the app icon bytes, a full file listing and a
 * preliminary safety report.
 *
 * Decompressors are injected so the same module works in the page (vendored
 * libs) and in Node tests (system tools / the same vendored libs):
 *   parseDeb(buffer, { gzip, xz, zstd, bzip2, lzma })
 *     — each: (Uint8Array) => Promise<Uint8Array>
 */

/* ------------------------------ ar archive ------------------------------- */

function parseAr(bytes) {
  const dec = new TextDecoder();
  if (dec.decode(bytes.subarray(0, 8)) !== "!<arch>\n") {
    throw new Error("不是有效的 .deb 文件（缺少 ar 魔数）");
  }
  const entries = [];
  let off = 8;
  while (off + 60 <= bytes.length) {
    const name = dec.decode(bytes.subarray(off, off + 16)).trim().replace(/\/$/, "");
    const size = parseInt(dec.decode(bytes.subarray(off + 48, off + 58)).trim(), 10);
    if (!Number.isFinite(size)) break;
    const start = off + 60;
    entries.push({ name, data: bytes.subarray(start, start + size) });
    off = start + size + (size % 2); // entries are 2-byte aligned
  }
  return entries;
}

/* --------------------------------- tar ----------------------------------- */

const TYPE_NAMES = {
  "0": "file", "\0": "file", "1": "hardlink", "2": "symlink",
  "3": "chardev", "4": "blockdev", "5": "dir", "6": "fifo",
};

function parseTar(bytes) {
  const dec = new TextDecoder();
  const files = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= bytes.length) {
    const block = bytes.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const rawName = dec.decode(block.subarray(0, 100)).split("\0")[0];
    const mode = parseInt(dec.decode(block.subarray(100, 108)).trim() || "0", 8);
    const size = parseInt(dec.decode(block.subarray(124, 136)).trim() || "0", 8);
    const typeflag = dec.decode(block.subarray(156, 157));
    const linkname = dec.decode(block.subarray(157, 257)).split("\0")[0];
    const prefix = dec.decode(block.subarray(345, 500)).split("\0")[0];
    const dataStart = off + 512;
    const data = bytes.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === "L") { // GNU long name: payload is the real name
      longName = dec.decode(data).split("\0")[0];
      continue;
    }
    let path = longName || (prefix ? `${prefix}/${rawName}` : rawName);
    longName = null;
    path = path.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!path) continue;
    files.push({
      path,
      mode,
      size,
      type: TYPE_NAMES[typeflag] || `type-${typeflag}`,
      linkname: linkname || null,
      data,
    });
  }
  return files;
}

/* ----------------------------- decompression ----------------------------- */

// Every compression deb(5) allows for control.tar / data.tar members.
async function extractMember(entries, base, decompressors) {
  for (const [suffix, kind] of [
    [".tar.gz", "gzip"], [".tar.xz", "xz"], [".tar.zst", "zstd"],
    [".tar.bz2", "bzip2"], [".tar.lzma", "lzma"], [".tar", "raw"],
  ]) {
    const entry = entries.find((e) => e.name === base + suffix);
    if (!entry) continue;
    if (kind === "raw") return parseTar(entry.data);
    const fn = decompressors[kind];
    if (!fn) throw new Error(`不支持的压缩格式: ${base}${suffix}`);
    return parseTar(await fn(entry.data));
  }
  throw new Error(`.deb 中缺少 ${base}.tar.* 成员`);
}

/* ------------------------------ field parsing ---------------------------- */

function parseControlFile(text) {
  const fields = {};
  let last = null;
  for (const line of text.split("\n")) {
    if (/^\s/.test(line) && last) {
      fields[last] += "\n" + line.trim();
    } else {
      const idx = line.indexOf(":");
      if (idx > 0) {
        last = line.slice(0, idx).trim();
        fields[last] = line.slice(idx + 1).trim();
      }
    }
  }
  return fields;
}

function parseDesktop(text) {
  const fields = {};
  let inEntry = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) { inEntry = t === "[Desktop Entry]"; continue; }
    if (!inEntry) continue;
    const idx = t.indexOf("=");
    if (idx > 0) fields[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return fields;
}

export function extractEmail(maintainer) {
  const m = /<([^>]+)>/.exec(maintainer || "");
  return m ? m[1].trim() : (maintainer || "").trim();
}

/**
 * Derive a GitHub login from a Maintainer string whose email is a GitHub
 * noreply address, else "". Handles both `login@users.noreply.github.com` and
 * the newer `12345+login@users.noreply.github.com` form. Used for ownership
 * attribution when no explicit `uploaded_by` record exists yet.
 */
export function loginFromNoreply(maintainer) {
  const email = extractEmail(maintainer).toLowerCase();
  const m = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(email);
  return m ? m[1] : "";
}

/* --------------------------- dpkg version compare ------------------------- */

function chOrder(c) {
  if (c === "~") return -1;
  if (c >= "0" && c <= "9") return 0;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  return c.charCodeAt(0) + 256;
}

function verrevcmp(a, b) {
  let ia = 0, ib = 0;
  const isDigit = (c) => c >= "0" && c <= "9";
  while (ia < a.length || ib < b.length) {
    let firstDiff = 0;
    while ((ia < a.length && !isDigit(a[ia])) || (ib < b.length && !isDigit(b[ib]))) {
      const ac = ia < a.length ? chOrder(a[ia]) : 0;
      const bc = ib < b.length ? chOrder(b[ib]) : 0;
      if (ac !== bc) return ac - bc;
      ia++; ib++;
    }
    while (a[ia] === "0") ia++;
    while (b[ib] === "0") ib++;
    while (ia < a.length && isDigit(a[ia]) && ib < b.length && isDigit(b[ib])) {
      if (!firstDiff) firstDiff = a.charCodeAt(ia) - b.charCodeAt(ib);
      ia++; ib++;
    }
    if (ia < a.length && isDigit(a[ia])) return 1;
    if (ib < b.length && isDigit(b[ib])) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}

/** dpkg --compare-versions 语义：返回 -1 / 0 / 1 */
export function compareDebVersions(va, vb) {
  const split = (v) => {
    v = v.trim();
    let epoch = 0;
    const ci = v.indexOf(":");
    if (ci > 0 && /^\d+$/.test(v.slice(0, ci))) { epoch = parseInt(v.slice(0, ci), 10); v = v.slice(ci + 1); }
    const di = v.lastIndexOf("-");
    return di >= 0 ? [epoch, v.slice(0, di), v.slice(di + 1)] : [epoch, v, ""];
  };
  const [ea, ua, ra] = split(va);
  const [eb, ub, rb] = split(vb);
  if (ea !== eb) return ea > eb ? 1 : -1;
  const rc = verrevcmp(ua, ub) || verrevcmp(ra, rb);
  return rc > 0 ? 1 : rc < 0 ? -1 : 0;
}

/* ------------------------------ safety report ---------------------------- */

/* --------------------------- install path policy -------------------------- */

// Roots that may only contain a subdirectory named after the package.
const PKG_DIR_ROOTS = ["usr/share/", "usr/lib/", "opt/", "var/lib/"];
// Debian Policy 10.1: on merged-usr systems these are symlinks into /usr and
// packages must not ship paths under them. lib/systemd/system is grandfathered
// in because already-published packages use it.
const ALIASED_ROOTS = ["bin/", "sbin/", "lib/", "lib32/", "lib64/", "libx32/"];
const SYSTEMD_DIRS = ["lib/systemd/system/", "usr/lib/systemd/system/"];
const UNIT_SUFFIX = /\.(service|socket|timer|target|path|mount)$/;

const ALLOWED_SUMMARY = "允许 usr/bin/<与包名相关的可执行文件>、" +
  "usr/share|usr/lib|opt|var/lib 下与包名相关的子目录、etc/ 下与包名相关的配置、" +
  "usr/share/APPLaunch/、usr/share/doc/、systemd 服务目录";

const normalizeName = (s) => s.toLowerCase().replace(/[-_.]/g, "");

/**
 * Is `name` recognizably the package's own? Compared with separators ignored
 * and in both directions, so package `fontpreview` accepts a `font_preview`
 * directory and package `myapp` accepts a `myapp-cli` binary, while neither
 * accepts `ls`.
 */
function namedAfterPackage(name, pkgName) {
  const a = normalizeName(name.replace(UNIT_SUFFIX, ""));
  const b = normalizeName(pkgName || "");
  return Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));
}

/**
 * Where a package is allowed to install files. Aligned with Debian rather than
 * a hand-rolled prefix list: /usr/bin is where Policy 10.1 says executables
 * belong, and a data directory need not be spelled exactly like the package
 * (Debian's own fonts-noto-cjk installs into /usr/share/fonts/opentype/noto/).
 * What is still enforced is that anything landing in a *shared* directory
 * carries the package's name, so an upload cannot quietly take over
 * /usr/bin/ls or sshd.service.
 *
 * Mirrored by the packages repo's process-web-submission.yml (install path
 * policy step), which is the authoritative check — keep the two in sync.
 *
 * Returns null when the path is fine, otherwise why it is not.
 */
export function installPathIssue(path, pkgName) {
  if (path.startsWith("usr/local/")) {
    return "Debian Policy 9.1.2 禁止软件包写入 /usr/local（那是留给系统管理员的）";
  }
  const systemdDir = SYSTEMD_DIRS.find((d) => path.startsWith(d));
  if (systemdDir) {
    const unit = path.slice(systemdDir.length);
    if (unit.includes("/")) return "systemd 服务目录下不应再有子目录";
    return namedAfterPackage(unit, pkgName)
      ? null
      : `systemd 服务名必须与包名 ${pkgName} 相关，避免覆盖系统服务`;
  }
  if (ALIASED_ROOTS.some((r) => path.startsWith(r))) {
    return "Debian Policy 10.1 禁止软件包写入 /bin /sbin /lib 等 usr-merge 别名路径，请改用 /usr 下的对应位置";
  }
  if (path.startsWith("usr/share/APPLaunch/") || path.startsWith("usr/share/doc/")) return null;
  // /etc/<pkg>.conf is as much a Debian convention as /etc/<pkg>/ (compare
  // rsyslog.conf, logrotate.conf), so a lone conffile is fine here.
  if (path.startsWith("etc/")) {
    const rest = path.slice("etc/".length);
    const top = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
    return namedAfterPackage(top, pkgName)
      ? null
      : `etc/ 下只能放与包名 ${pkgName} 相关的配置文件或目录，${top} 不符合`;
  }
  if (path.startsWith("usr/bin/")) {
    const exe = path.slice("usr/bin/".length);
    if (exe.includes("/")) {
      return "/usr/bin 下不应有子目录，程序数据请放 usr/share/<包名>/ 或 usr/lib/<包名>/";
    }
    return namedAfterPackage(exe, pkgName)
      ? null
      : `/usr/bin 下的文件名必须与包名 ${pkgName} 相关，避免覆盖系统命令`;
  }
  const root = PKG_DIR_ROOTS.find((r) => path.startsWith(r));
  if (root) {
    const rest = path.slice(root.length);
    if (!rest.includes("/")) return `不能直接放在 ${root} 下，请放进 ${root}<包名>/ 子目录`;
    const top = rest.slice(0, rest.indexOf("/"));
    return namedAfterPackage(top, pkgName)
      ? null
      : `${root}${top}/ 的目录名必须与包名 ${pkgName} 相关`;
  }
  return `不在允许的安装位置内（${ALLOWED_SUMMARY}）`;
}

/**
 * Handed to the developer whenever a path is rejected, here and in the failure
 * issue the Action opens. Self-contained on purpose: it carries the whole policy
 * plus the offending paths, so pasting it into an assistant is enough to get the
 * packaging fixed. Mirrored in process-web-submission.yml (PROMPT) and kept
 * verbatim by test/installpath.test.js.
 */
const INSTALL_PATH_PROMPT = `我在给 CardputerZero AppStore 打一个 Debian 包（.deb），提交后被商店的安装路径检查拒绝了。
请帮我修改打包脚本（CMakeLists.txt / debian/rules / install 脚本 / Makefile，看项目里用的是哪种），
把文件装到合规位置，并同步更新 .desktop 里的 Exec 和 Icon、以及代码里读取资源文件的路径。

商店的规则（包名记作 PKG，比对时忽略 - _ . 的差异，所以 PKG 是 fontpreview 时目录叫 font_preview 也算合规）：

允许安装到：
- usr/bin/<名字>：可执行文件，名字必须与包名相关（这是 Debian Policy 10.1 的标准位置）
- usr/share/<与包名相关的目录>/**：图片、字体、音频等只读资源
- usr/lib/<与包名相关的目录>/**：私有库、插件
- opt/<与包名相关的目录>/**：整体打包自带的目录
- etc/<与包名相关的目录>/** 或 etc/<与包名相关>.conf：配置文件（Debian conffile 惯例）
- var/lib/<与包名相关的目录>/**：运行时数据
- usr/share/APPLaunch/**：CardputerZero 启动器资源，且必须有 usr/share/APPLaunch/applications/<名字>.desktop
- usr/share/doc/**：文档
- lib/systemd/system/<与包名相关>.service 或 usr/lib/systemd/system/<同样>：服务名必须与包名相关，
  且 [Service] 段必须写 User=<非 root 用户>（商店拒绝以 root 运行的服务）

禁止：
- usr/local/** —— Debian Policy 9.1.2 明令禁止软件包写入
- 以 bin/ sbin/ lib/ lib32/ lib64/ libx32/ 开头的路径 —— Debian Policy 10.1（usr-merge 别名路径），请改用 usr/ 下的对应位置
- 直接散落在 usr/share/ 或 usr/lib/ 下的文件 —— 必须收进以包名命名的子目录
- 在 usr/bin/ 下建子目录
- 名字与包名无关的共享目录名、可执行文件名或服务名（这是为了防止覆盖系统文件）
- setuid/setgid 文件、设备文件

我的包名 PKG = {pkg}
这次被拒绝的路径：
{paths}

请告诉我具体要改哪些文件、改成什么，以及资源路径在源码里怎么同步修改。`;

// Where the Action looks for system units, etc/systemd/system included even
// though the path policy rejects it — a unit there still runs as root.
const SERVICE_SCAN_DIRS = [
  "lib/systemd/system/", "usr/lib/systemd/system/", "etc/systemd/system/",
];

/**
 * Does this unit run as root? Apps must not, and the packages Action rejects the
 * package when they do, so the same reading is done here: root unless [Service]
 * names a non-root User= or turns on DynamicUser=.
 */
export function unitRunsAsRoot(text) {
  let inService = false, user = null, dynamic = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#" || line[0] === ";") continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inService = line.toLowerCase() === "[service]";
      continue;
    }
    if (!inService || !line.includes("=")) continue;
    const key = line.slice(0, line.indexOf("=")).trim().toLowerCase();
    const value = line.slice(line.indexOf("=") + 1).trim();
    if (key === "user") user = value;
    else if (key === "dynamicuser") dynamic = ["1", "yes", "true", "on"].includes(value.toLowerCase());
  }
  if (dynamic) return false;
  if (!user) return true;
  return user === "root" || user === "0";
}

/** The prompt above, filled in for this package and its rejected paths. */
export function installPathPrompt(pkgName, badPaths) {
  const shown = badPaths.slice(0, 40).join("\n");
  const rest = badPaths.length > 40 ? `\n…（另外 ${badPaths.length - 40} 条同类问题）` : "";
  return INSTALL_PATH_PROMPT.replace("{pkg}", pkgName).replace("{paths}", shown + rest);
}

const SCRIPT_PATTERNS = [
  [/rm\s+(-\w+\s+)*(\/|\$\{?HOME)/, "danger", "maintainer 脚本包含对根目录/家目录的删除操作"],
  [/(curl|wget)[^\n]*\|\s*(ba)?sh/, "danger", "maintainer 脚本从网络下载并直接执行代码"],
  [/base64\s+(-d|--decode)/, "warn", "maintainer 脚本包含 base64 解码（可能隐藏内容）"],
  [/\b(nc|ncat|netcat)\b/, "warn", "maintainer 脚本调用 netcat"],
  [/dd\s+[^\n]*of=\/dev\//, "danger", "maintainer 脚本直接写入设备文件"],
  [/mkfs|fdisk|parted/, "danger", "maintainer 脚本包含磁盘分区/格式化命令"],
  [/\/etc\/(passwd|shadow|sudoers)/, "danger", "maintainer 脚本操作系统认证文件"],
  [/chmod\s+[0-7]*[4267][0-7]{2,}\s/, "warn", "maintainer 脚本修改敏感权限位"],
  [/crontab|\/etc\/cron/, "warn", "maintainer 脚本安装计划任务"],
  [/systemctl\s+(enable|start)/, "info", "maintainer 脚本启用 systemd 服务（APPLaunch 应用常见）"],
];

function analyzeFiles(dataFiles, report, pkgName) {
  let elfCount = 0, wrongArchElf = 0, totalSize = 0;
  const badPaths = [];
  for (const f of dataFiles) {
    totalSize += f.size;
    if (f.path.includes("..")) {
      report.push(["danger", `路径穿越: ${f.path}`]);
    }
    if (f.type === "chardev" || f.type === "blockdev") {
      report.push(["danger", `包含设备文件: ${f.path}`]);
    }
    if (f.type === "file") {
      if (f.mode & 0o4000) report.push(["danger", `setuid 可执行文件: ${f.path}`]);
      if (f.mode & 0o2000) report.push(["warn", `setgid 文件: ${f.path}`]);
      if (f.mode & 0o002) report.push(["warn", `全局可写文件: ${f.path}`]);
      if (f.size > 50 * 1024 * 1024) {
        report.push(["warn", `超大文件 (${(f.size / 1048576).toFixed(0)} MB): ${f.path}`]);
      }
      if (f.size >= 20 && f.data[0] === 0x7f && f.data[1] === 0x45 && f.data[2] === 0x4c && f.data[3] === 0x46) {
        elfCount++;
        const machine = f.data[18] | (f.data[19] << 8);
        if (machine !== 183) { // EM_AARCH64
          wrongArchElf++;
          report.push(["warn", `非 arm64 的 ELF 二进制 (e_machine=${machine}): ${f.path}`]);
        }
      }
    }
    if (f.type === "symlink" && f.linkname && f.linkname.startsWith("/") &&
        !f.linkname.startsWith("/usr/share/APPLaunch")) {
      report.push(["warn", `符号链接指向包外绝对路径: ${f.path} -> ${f.linkname}`]);
    }
    // Blocking, not a warning: the packages-repo Action rejects these outright,
    // so flagging them any softer would let the developer upload a package that
    // is already doomed. Skipped without a package name, since nothing can then
    // be judged as the package's own and the missing field is reported already.
    if (f.type !== "dir" && pkgName) {
      const issue = installPathIssue(f.path, pkgName);
      if (issue) {
        report.push(["danger", `安装路径不合规: ${f.path} —— ${issue}`]);
        badPaths.push(f.path);
      }
    }
    if (f.type === "file" && f.path.endsWith(".service")
        && SERVICE_SCAN_DIRS.some((d) => f.path.startsWith(d))
        && unitRunsAsRoot(new TextDecoder().decode(f.data))) {
      report.push(["danger", `systemd 服务以 root 运行: ${f.path} —— `
        + "应用不允许以 root 运行，请在 [Service] 段加 User=<非 root 用户> 或 DynamicUser=yes"]);
    }
  }
  return { elfCount, wrongArchElf, totalSize, badPaths };
}

/* --------------------------------- main ---------------------------------- */

/**
 * @param {ArrayBuffer|Uint8Array} buffer  the .deb bytes
 * @param {{gzip:Function, xz:Function, zstd:Function}} decompressors
 * @returns {Promise<object>} 解析与检查结果
 */
export async function parseDeb(buffer, decompressors) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const report = []; // [level, message]; level: pass | info | warn | danger

  const entries = parseAr(bytes);
  const controlFiles = await extractMember(entries, "control", decompressors);
  const dataFiles = await extractMember(entries, "data", decompressors);
  const dec = new TextDecoder();

  // control fields
  const controlEntry = controlFiles.find((f) => f.path === "control");
  if (!controlEntry) throw new Error(".deb 中缺少 control 文件");
  const control = parseControlFile(dec.decode(controlEntry.data));
  for (const field of ["Package", "Version", "Architecture", "Maintainer"]) {
    if (!control[field]) report.push(["danger", `control 缺少 ${field} 字段`]);
  }
  if (control.Package && !/^[a-z0-9][a-z0-9.+-]+$/.test(control.Package)) {
    report.push(["danger", `包名不合法: ${control.Package}`]);
  }
  if (control.Architecture && !["arm64", "all"].includes(control.Architecture)) {
    report.push(["danger", `架构必须是 arm64 或 all，当前: ${control.Architecture}`]);
  }

  // maintainer scripts
  const scripts = {};
  for (const name of ["preinst", "postinst", "prerm", "postrm"]) {
    const f = controlFiles.find((e) => e.path === name);
    if (!f) continue;
    const text = dec.decode(f.data);
    scripts[name] = text;
    for (const [re, level, msg] of SCRIPT_PATTERNS) {
      if (re.test(text)) report.push([level, `${msg}（${name}）`]);
    }
  }

  // .desktop
  const desktopFile = dataFiles.find(
    (f) => f.type === "file" && /^usr\/share\/APPLaunch\/applications\/[^/]+\.desktop$/.test(f.path),
  );
  let desktop = null;
  if (desktopFile) {
    desktop = { path: desktopFile.path, ...parseDesktop(dec.decode(desktopFile.data)) };
    report.push(["pass", `.desktop: ${desktopFile.path}`]);
    if (!desktop.Name) report.push(["warn", ".desktop 缺少 Name"]);
    if (!desktop.Exec) report.push(["danger", ".desktop 缺少 Exec"]);
  } else {
    report.push(["danger", "缺少 usr/share/APPLaunch/applications/*.desktop（商店应用必须提供）"]);
  }

  // icon
  let icon = null;
  if (desktop && desktop.Icon) {
    const rel = desktop.Icon.replace(/^\//, "");
    const candidates = [rel, `usr/share/APPLaunch/${rel}`];
    const f = dataFiles.find((e) => e.type === "file" && candidates.includes(e.path));
    if (f) {
      const isPng = f.data.length > 8 && f.data[0] === 0x89 && f.data[1] === 0x50;
      icon = { path: f.path, bytes: f.data.slice(), isPng };
      report.push([isPng ? "pass" : "warn", isPng ? `图标: ${f.path}` : `图标不是 PNG: ${f.path}`]);
    } else {
      report.push(["warn", `.desktop 声明的图标未打进包里: ${desktop.Icon}`]);
    }
  }

  const stats = analyzeFiles(dataFiles, report, control.Package);
  if (stats.elfCount > 0) {
    report.push(["info", `包含 ${stats.elfCount} 个 ELF 二进制${stats.wrongArchElf ? `（其中 ${stats.wrongArchElf} 个架构可疑）` : "（架构均为 arm64）"}`]);
  }
  if (Object.keys(scripts).length) {
    report.push(["info", `包含 maintainer 脚本: ${Object.keys(scripts).join(", ")}`]);
  }

  const danger = report.filter(([l]) => l === "danger").length;
  const warn = report.filter(([l]) => l === "warn").length;

  return {
    control,
    email: extractEmail(control.Maintainer),
    desktop,
    icon,
    scripts,
    files: dataFiles.map(({ path, size, mode, type, linkname }) => ({ path, size, mode, type, linkname })),
    totalInstalledSize: stats.totalSize,
    report,
    // Non-empty only when the install path policy rejected something, in which
    // case the page offers the fix-it prompt for these paths.
    badPaths: stats.badPaths,
    verdict: danger ? "danger" : warn ? "warn" : "pass",
  };
}
