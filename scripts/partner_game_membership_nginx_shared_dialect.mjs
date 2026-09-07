// Constrained OFFLINE compatibility checks. No native grammar, module custody,
// loaded-config proof or I/O. Unknown inherited behavior is rejected, not guessed.
import path from "node:path";
import { scanNginxInventoryStructure } from "./partner_game_membership_nginx_lexical.mjs";
import { PartnerIngressEvidenceError } from "./partner_game_membership_ingress_evidence.mjs";

const fail = code => { throw new PartnerIngressEvidenceError(`NGINX_SHARED_DIALECT_${code}`); };
const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const number = value => /^[1-9][0-9]{0,8}$/.test(value);
const size = value => /^[1-9][0-9]{0,7}[km]?$/.test(value);
const duration = value => /^(?:0|[1-9][0-9]{0,5})[smh]?$/.test(value);
const off = args => same(args, ["off"]);
const onOff = args => args.length === 1 && ["on", "off"].includes(args[0]);
const protocols = args => same([...args].sort(), ["TLSv1.2", "TLSv1.3"]);
const reservedVariable = value => /^\$(?:pgm_v02_|http_|ssl_|request(?:_|$)|upstream_|sent_|connection(?:_|$)|binary_remote_addr$|remote_|server_|pid$|uri$|args$|is_args$|msec$|limit_|hostname$|scheme$|status$|time_)/i.test(value);
const early = {
  ssl_protocols: protocols,
  client_header_buffer_size: args => same(args, ["2k"]),
  large_client_header_buffers: args => same(args, ["7", "2k"]),
  client_header_timeout: args => same(args, ["5s"]),
  ignore_invalid_headers: args => same(args, ["on"]),
  underscores_in_headers: off,
};
const inherited = {
  ...early, sendfile: onOff, tcp_nopush: onOff, tcp_nodelay: onOff,
  keepalive_timeout: a => a.length === 1 && duration(a[0]),
  types_hash_max_size: a => a.length === 1 && number(a[0]),
  types_hash_bucket_size: a => a.length === 1 && number(a[0]),
  server_names_hash_bucket_size: a => a.length === 1 && number(a[0]),
  variables_hash_max_size: a => a.length === 1 && number(a[0]),
  default_type: a => a.length === 1 && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(a[0]),
  client_max_body_size: a => a.length === 1 && size(a[0]),
  client_body_buffer_size: a => a.length === 1 && size(a[0]),
  client_body_timeout: a => a.length === 1 && duration(a[0]),
  server_tokens: off, auth_basic: off, auth_request: off, mirror: off,
  expires: off, charset: off, gzip: onOff, ssl_prefer_server_ciphers: onOff,
  ssl_session_tickets: onOff, ssl_session_timeout: a => a.length === 1 && duration(a[0]),
  ssl_session_cache: a => a.length === 1 && /^(?:off|none|shared:[A-Za-z0-9_-]+:[1-9][0-9]*m)$/.test(a[0]),
  ssl_ciphers: a => a.length === 1 && /^[A-Za-z0-9_!:+@.-]+$/.test(a[0]),
  ssl_dhparam: a => a.length === 1 && /^\/etc\/[A-Za-z0-9_./-]+$/.test(a[0]),
  proxy_pass_request_body: a => same(a, ["on"]), proxy_pass_request_headers: a => same(a, ["on"]),
  // These are replaced by the overlay's own server-level declarations (1.24).
  access_log: a => a.length >= 1 && a.length <= 4,
  error_log: a => a.length >= 1 && a.length <= 2,
  add_header: a => a.length >= 2 && a.length <= 3,
  log_format: a => a.length >= 2 && a.length <= 4 && /^[A-Za-z0-9_]+$/.test(a[0]),
  limit_req_zone: a => a.length === 3 && /^\$[a-zA-Z0-9_]+$/.test(a[0]) && /^zone=[a-zA-Z0-9_]+:[1-9][0-9]*m$/.test(a[1]) && /^rate=[1-9][0-9]*r\/[sm]$/.test(a[2]),
  limit_conn_zone: a => a.length === 2 && /^\$[a-zA-Z0-9_]+$/.test(a[0]) && /^zone=[a-zA-Z0-9_]+:[1-9][0-9]*m$/.test(a[1]),
};

export function checkLocalSharedNginxDialect(files) {
  // Caller is the source-owned preparation wrapper, already byte/path bounded.
  // This independently exported checker never creates a trusted preparation.
  if (!(files instanceof Map) || files.size < 1 || files.size > 64 || !files.has("/etc/nginx/nginx.conf")) fail("INPUT_INVALID");
  const records = new Map();
  for (const [name, bytes] of files) {
    try { records.set(name, scanNginxInventoryStructure(Buffer.from(bytes).toString("utf8"))); }
    catch { fail("LEXICAL_UNSUPPORTED"); }
  }
  let visits = 0, rowCount = 0, sequence = 0, httpCount = 0, workerDeclarations = 0;
  const global = {}, servers = new Map();
  const assign = (store, head, args) => { if (Object.hasOwn(store, head)) fail("DUPLICATE_SETTING"); store[head] = args; };
  const visit = (name, parents = [], stack = []) => {
    if (++visits > 2048 || stack.length > 8 || stack.includes(name)) fail("INCLUDE_LIMIT");
    const instance = ++sequence;
    for (const row of records.get(name) ?? fail("MISSING_INCLUDE")) {
      if (++rowCount > 50000) fail("ROW_LIMIT");
      const [head, ...args] = row.words.map(word => word.value);
      const context = [...parents, ...row.context.map((kind, i) => ({ kind, id: `${instance}:${row.contextIds[i]}` }))];
      const kinds = context.map(item => item.kind);
      const dataBlock = same(kinds, ["http", "map"]) || same(kinds, ["http", "types"]);
      // Variable registration is http-global even for sibling set/captures. Do
      // not confuse ordinary references with declarations or trust local scope.
      if (!dataBlock && head === "set" && reservedVariable(args[0] ?? "")) fail("RESERVED_VARIABLE_OVERRIDE");
      for (const [index, word] of row.words.entries()) {
        // Bare PCRE apostrophe captures retain internal quotes in Nginx, while
        // this bounded lexer's legacy decoded value removes them. Check both
        // spellings; neither is exported or promoted to a native grammar proof.
        for (const spelling of [word.value, row.rawWords[index]]) {
          for (const match of spelling.matchAll(/\(\?(?:P?<([A-Za-z_][A-Za-z0-9_]*)>|'([A-Za-z_][A-Za-z0-9_]*)')/g)) {
            if (reservedVariable(`$${match[1] ?? match[2]}`)) fail("RESERVED_VARIABLE_OVERRIDE");
          }
        }
      }
      if (head === "include") {
        if (row.block || args.length !== 1) fail("INCLUDE_UNSUPPORTED");
        const pattern = args[0];
        const glob = ["/etc/nginx/conf.d/*.conf", "/etc/nginx/sites-enabled/*", "/etc/nginx/modules-enabled/*.conf"].includes(pattern);
        const dir = path.posix.dirname(pattern) + "/";
        const targets = glob ? [...files.keys()].filter(p => p.startsWith(dir) && !p.slice(dir.length).includes("/")
          && !p.slice(dir.length).startsWith(".") && (!pattern.endsWith(".conf") || p.endsWith(".conf"))).sort() : [pattern];
        for (const target of targets) visit(target, context, [...stack, name]);
        continue;
      }
      if (dataBlock) { if (row.block) fail("DATA_BLOCK_UNSUPPORTED"); continue; }
      if (head === "load_module") fail("MODULE_CUSTODY_UNPROVEN");
      if (head === "worker_processes") {
        // Only declaration compatibility: auto is NOT an observed worker count.
        // The generation evaluator still requires four actual workers in every
        // snapshot and complete coverage; no CPU lookup or caller override here.
        if (kinds.length || row.block || args.length !== 1 || !["4", "auto"].includes(args[0])) fail("MAIN_UNSUPPORTED");
        if (++workerDeclarations !== 1) fail("DUPLICATE_SETTING");
        continue;
      }
      if (!kinds.length) {
        if (row.block && head === "http" && !args.length) { if (++httpCount !== 1) fail("HTTP_CONTEXT"); continue; }
        if (row.block && head === "events" && !args.length) continue;
        if (row.block || !["user", "pid", "error_log", "worker_rlimit_nofile"].includes(head)) fail("MAIN_UNSUPPORTED");
        if (!args.length || args.length > 2) fail("MAIN_UNSUPPORTED");
        continue;
      }
      if (same(kinds, ["events"])) {
        if (row.block || !(head === "worker_connections" && args.length === 1 && number(args[0])
          || head === "multi_accept" && onOff(args) || head === "use" && same(args, ["epoll"]))) fail("EVENTS_UNSUPPORTED");
        continue;
      }
      if (same(kinds, ["http"])) {
        if (row.block && head === "server" && !args.length) { servers.set(`${instance}:${row.blockId}`, {}); continue; }
        if (row.block && head === "map" && args.length === 2 && args.every(a => /^\$[a-zA-Z0-9_]+$/.test(a))) {
          if (reservedVariable(args[1])) fail("RESERVED_VARIABLE_OVERRIDE");
          continue;
        }
        if (row.block && head === "types" && !args.length) continue;
        if (row.block || !Object.hasOwn(inherited, head) || !inherited[head](args)) fail("INHERITED_UNSUPPORTED");
        if (Object.hasOwn(early, head)) assign(global, head, args);
        continue;
      }
      if (kinds[0] !== "http" || kinds[1] !== "server") fail("CONTEXT_UNSUPPORTED");
      const server = servers.get(context[1].id);
      if (!server) fail("SERVER_CONTEXT");
      if (kinds.length !== 2) continue; // Unchanged sibling-only request handling.
      if (head === "listen") {
        if (row.block || !["443", "[::]:443", "80", "[::]:80"].includes(args[0])
          || new Set(args).size !== args.length || args.slice(1).some(a => !["ssl", "default_server", "ipv6only=on"].includes(a))
          || args[0].endsWith("443") !== args.includes("ssl")
          || args.includes("ipv6only=on") && !args[0].startsWith("[::]:")) fail("LISTENER_UNSUPPORTED");
        (server.listeners ??= []).push(args);
      } else if (Object.hasOwn(early, head) || head === "ssl_conf_command") {
        assign(server, head, args);
      }
    }
  };
  visit("/etc/nginx/nginx.conf");
  if (httpCount !== 1) fail("HTTP_CONTEXT");
  if (workerDeclarations !== 1) fail("WORKER_DECLARATION_REQUIRED");
  const defaults = new Map();
  for (const server of servers.values()) {
    for (const args of server.listeners ?? []) {
      if (!args[0].endsWith("443")) continue;
      if (Object.hasOwn(server, "ssl_conf_command")) fail("TLS_CONFIGURATION_UNSUPPORTED");
      if (args.includes("default_server")) {
        if (defaults.has(args[0])) fail("DEFAULT_CONFLICT");
        defaults.set(args[0], server);
      }
    }
  }
  for (const family of ["443", "[::]:443"]) {
    const server = defaults.get(family);
    if (!server) fail("EXPLICIT_DEFAULT_REQUIRED");
    for (const [head, validate] of Object.entries(early)) {
      if (!validate(server[head] ?? global[head] ?? [])) fail("EARLY_TLS_OR_HEADERS_UNPROVEN");
    }
  }
  return Object.freeze({ state: "LOCAL_SHARED_DIALECT_CHECKED_NOT_NATIVE_PROOF", explicitUnchangedDefaults: 2,
    productionVerified: false, deployAuthorized: false, activationAuthorized: false,
    nativeValidation: "NOT_RUN", staticModuleCustody: "NOT_PROVEN", loadedConfiguration: "NOT_PROVEN" });
}
