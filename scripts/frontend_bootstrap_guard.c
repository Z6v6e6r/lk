#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1U << 1)
#endif

#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC (1U << 2)
#endif

#define EXIT_ARGUMENT 64
#define EXIT_CUSTODY 65
#define EXIT_LOCK 66
#define EXIT_CHILD 67
#define EXIT_EXCHANGE 68
#define CHILD_TIMEOUT_SECONDS 1800

#define GLOBAL_LOCK "/var/www/html/.lk-frontend-bootstrap.lock"
#define NGINX_LOCK "/etc/nginx/.padlhub-nginx-writer.lock"
#define RELEASE_LOCK "/var/www/html/lk-frontend-releases/.lock"
#define NGINX_DIRECTORY "/etc/nginx/sites-enabled"
#define NGINX_NAME "padlhub.su"
#define NODE_PATH "/usr/bin/node"

typedef struct {
  uint32_t state[8];
  uint64_t bit_count;
  uint8_t buffer[64];
  size_t buffer_length;
} sha256_context;

typedef struct {
  const char *mode;
  const char *action;
  const char *bundle;
  const char *manifest_sha256;
  const char *attempt_id;
  const char *expected_self_sha256;
  const char *runtime_sha256;
  const char *node_sha256;
  const char *authority;
  const char *replacement;
  const char *expected_current_sha256;
  const char *expected_replacement_sha256;
} options;

static const uint32_t sha256_constants[64] = {
  0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
  0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
  0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
  0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
  0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
  0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
  0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
  0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
};

static void fail(int code, const char *message) {
  fprintf(stderr, "%s\n", message);
  exit(code);
}

static void mark_inherited_descriptors_close_on_exec(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, ~0U, CLOSE_RANGE_CLOEXEC) == 0) return;
  if (errno != ENOSYS && errno != EINVAL) fail(EXIT_CUSTODY, "INHERITED_FD_SANITIZE_FAILED");
#endif
  long limit = sysconf(_SC_OPEN_MAX);
  if (limit < 0) fail(EXIT_CUSTODY, "INHERITED_FD_SANITIZE_FAILED");
  for (long descriptor = 3; descriptor < limit; descriptor += 1) {
    int flags = fcntl((int)descriptor, F_GETFD);
    if (flags < 0) {
      if (errno == EBADF) continue;
      fail(EXIT_CUSTODY, "INHERITED_FD_SANITIZE_FAILED");
    }
    if (fcntl((int)descriptor, F_SETFD, flags | FD_CLOEXEC) < 0) {
      fail(EXIT_CUSTODY, "INHERITED_FD_SANITIZE_FAILED");
    }
  }
}

static uint32_t rotate_right(uint32_t value, unsigned count) {
  return (value >> count) | (value << (32U - count));
}

static void sha256_transform(sha256_context *context, const uint8_t block[64]) {
  uint32_t words[64];
  for (size_t index = 0; index < 16; index += 1) {
    words[index] = ((uint32_t)block[index * 4] << 24)
      | ((uint32_t)block[index * 4 + 1] << 16)
      | ((uint32_t)block[index * 4 + 2] << 8)
      | (uint32_t)block[index * 4 + 3];
  }
  for (size_t index = 16; index < 64; index += 1) {
    uint32_t s0 = rotate_right(words[index - 15], 7) ^ rotate_right(words[index - 15], 18)
      ^ (words[index - 15] >> 3);
    uint32_t s1 = rotate_right(words[index - 2], 17) ^ rotate_right(words[index - 2], 19)
      ^ (words[index - 2] >> 10);
    words[index] = words[index - 16] + s0 + words[index - 7] + s1;
  }
  uint32_t a = context->state[0], b = context->state[1], c = context->state[2], d = context->state[3];
  uint32_t e = context->state[4], f = context->state[5], g = context->state[6], h = context->state[7];
  for (size_t index = 0; index < 64; index += 1) {
    uint32_t sum1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
    uint32_t choice = (e & f) ^ ((~e) & g);
    uint32_t temporary1 = h + sum1 + choice + sha256_constants[index] + words[index];
    uint32_t sum0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t temporary2 = sum0 + majority;
    h = g; g = f; f = e; e = d + temporary1; d = c; c = b; b = a; a = temporary1 + temporary2;
  }
  context->state[0] += a; context->state[1] += b; context->state[2] += c; context->state[3] += d;
  context->state[4] += e; context->state[5] += f; context->state[6] += g; context->state[7] += h;
}

static void sha256_init(sha256_context *context) {
  memset(context, 0, sizeof(*context));
  const uint32_t initial[8] = { 0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U };
  memcpy(context->state, initial, sizeof(initial));
}

static void sha256_update(sha256_context *context, const uint8_t *data, size_t length) {
  for (size_t index = 0; index < length; index += 1) {
    context->buffer[context->buffer_length++] = data[index];
    if (context->buffer_length == sizeof(context->buffer)) {
      sha256_transform(context, context->buffer);
      context->bit_count += 512;
      context->buffer_length = 0;
    }
  }
}

static void sha256_final(sha256_context *context, uint8_t digest[32]) {
  context->bit_count += (uint64_t)context->buffer_length * 8U;
  context->buffer[context->buffer_length++] = 0x80U;
  if (context->buffer_length > 56) {
    while (context->buffer_length < 64) context->buffer[context->buffer_length++] = 0;
    sha256_transform(context, context->buffer);
    context->buffer_length = 0;
  }
  while (context->buffer_length < 56) context->buffer[context->buffer_length++] = 0;
  for (int index = 7; index >= 0; index -= 1) {
    context->buffer[context->buffer_length++] = (uint8_t)(context->bit_count >> (index * 8));
  }
  sha256_transform(context, context->buffer);
  for (size_t index = 0; index < 8; index += 1) {
    digest[index * 4] = (uint8_t)(context->state[index] >> 24);
    digest[index * 4 + 1] = (uint8_t)(context->state[index] >> 16);
    digest[index * 4 + 2] = (uint8_t)(context->state[index] >> 8);
    digest[index * 4 + 3] = (uint8_t)context->state[index];
  }
}

static int hex64(const char *value) {
  if (value == NULL || strlen(value) != 64) return 0;
  for (size_t index = 0; index < 64; index += 1) {
    if (!((value[index] >= '0' && value[index] <= '9') || (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return 1;
}

static int hex32(const char *value) {
  if (value == NULL || strlen(value) != 32) return 0;
  for (size_t index = 0; index < 32; index += 1) {
    if (!((value[index] >= '0' && value[index] <= '9') || (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return 1;
}

static int try_digest_fd(int descriptor, char output[65]) {
  if (lseek(descriptor, 0, SEEK_SET) < 0) return 0;
  sha256_context context;
  sha256_init(&context);
  uint8_t buffer[16384];
  for (;;) {
    ssize_t length = read(descriptor, buffer, sizeof(buffer));
    if (length < 0) {
      if (errno == EINTR) continue;
      return 0;
    }
    if (length == 0) break;
    sha256_update(&context, buffer, (size_t)length);
  }
  uint8_t digest[32];
  sha256_final(&context, digest);
  for (size_t index = 0; index < 32; index += 1) sprintf(output + index * 2, "%02x", digest[index]);
  output[64] = '\0';
  return 1;
}

static void digest_fd(int descriptor, char output[65]) {
  if (!try_digest_fd(descriptor, output)) fail(EXIT_CUSTODY, "DIGEST_READ_FAILED");
}

static struct stat inspect_regular(int descriptor, mode_t exact_mode, int require_exact_mode, const char *message) {
  struct stat value;
  if (fstat(descriptor, &value) != 0 || !S_ISREG(value.st_mode) || value.st_uid != 0 || value.st_gid != 0
    || value.st_nlink != 1 || (value.st_mode & 0022) != 0
    || (require_exact_mode && (value.st_mode & 0777) != exact_mode)) fail(EXIT_CUSTODY, message);
  return value;
}

static int same_stat(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino
    && left->st_uid == right->st_uid && left->st_gid == right->st_gid
    && left->st_mode == right->st_mode && left->st_nlink == right->st_nlink
    && left->st_size == right->st_size
    && left->st_mtim.tv_sec == right->st_mtim.tv_sec && left->st_mtim.tv_nsec == right->st_mtim.tv_nsec
    && left->st_ctim.tv_sec == right->st_ctim.tv_sec && left->st_ctim.tv_nsec == right->st_ctim.tv_nsec;
}

static int open_verified(const char *target, const char *expected, mode_t exact_mode,
  int require_exact_mode, const char *message) {
  int descriptor = open(target, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) fail(EXIT_CUSTODY, message);
  struct stat before = inspect_regular(descriptor, exact_mode, require_exact_mode, message);
  char digest[65];
  digest_fd(descriptor, digest);
  struct stat after;
  if (fstat(descriptor, &after) != 0 || !same_stat(&before, &after)) fail(EXIT_CUSTODY, message);
  if (strcmp(digest, expected) != 0) fail(EXIT_CUSTODY, message);
  if (lseek(descriptor, 0, SEEK_SET) < 0) fail(EXIT_CUSTODY, message);
  return descriptor;
}

static int move_descriptor_high(int descriptor, const char *message) {
  int moved = fcntl(descriptor, F_DUPFD_CLOEXEC, 10);
  close(descriptor);
  if (moved < 0) fail(EXIT_CUSTODY, message);
  return moved;
}

static const char *argument_value(options *result, const char *key) {
  if (strcmp(key, "--action") == 0) return result->action;
  if (strcmp(key, "--bundle") == 0) return result->bundle;
  if (strcmp(key, "--manifest-sha256") == 0) return result->manifest_sha256;
  if (strcmp(key, "--attempt-id") == 0) return result->attempt_id;
  if (strcmp(key, "--expected-self-sha256") == 0) return result->expected_self_sha256;
  if (strcmp(key, "--runtime-sha256") == 0) return result->runtime_sha256;
  if (strcmp(key, "--node-sha256") == 0) return result->node_sha256;
  if (strcmp(key, "--authority") == 0) return result->authority;
  if (strcmp(key, "--replacement") == 0) return result->replacement;
  if (strcmp(key, "--expected-current-sha256") == 0) return result->expected_current_sha256;
  if (strcmp(key, "--expected-replacement-sha256") == 0) return result->expected_replacement_sha256;
  fail(EXIT_ARGUMENT, "UNKNOWN_ARGUMENT");
  return NULL;
}

static void set_argument(options *result, const char *key, const char *value) {
  if (argument_value(result, key) != NULL) fail(EXIT_ARGUMENT, "DUPLICATE_ARGUMENT");
  if (strcmp(key, "--action") == 0) result->action = value;
  else if (strcmp(key, "--bundle") == 0) result->bundle = value;
  else if (strcmp(key, "--manifest-sha256") == 0) result->manifest_sha256 = value;
  else if (strcmp(key, "--attempt-id") == 0) result->attempt_id = value;
  else if (strcmp(key, "--expected-self-sha256") == 0) result->expected_self_sha256 = value;
  else if (strcmp(key, "--runtime-sha256") == 0) result->runtime_sha256 = value;
  else if (strcmp(key, "--node-sha256") == 0) result->node_sha256 = value;
  else if (strcmp(key, "--authority") == 0) result->authority = value;
  else if (strcmp(key, "--replacement") == 0) result->replacement = value;
  else if (strcmp(key, "--expected-current-sha256") == 0) result->expected_current_sha256 = value;
  else if (strcmp(key, "--expected-replacement-sha256") == 0) result->expected_replacement_sha256 = value;
}

static options parse_options(int argc, char **argv) {
  if (argc < 2 || ((argc - 2) % 2) != 0) fail(EXIT_ARGUMENT, "ARGUMENT_CONTRACT_MISMATCH");
  options result;
  memset(&result, 0, sizeof(result));
  result.mode = argv[1];
  if (strcmp(result.mode, "run") != 0 && strcmp(result.mode, "exchange") != 0) {
    fail(EXIT_ARGUMENT, "MODE_INVALID");
  }
  for (int index = 2; index < argc; index += 2) set_argument(&result, argv[index], argv[index + 1]);
  if (!hex64(result.expected_self_sha256) || !hex32(result.attempt_id)) fail(EXIT_ARGUMENT, "IDENTITY_INVALID");
  return result;
}

static int verify_self(const char *expected) {
  int descriptor = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) fail(EXIT_CUSTODY, "SELF_OPEN_FAILED");
  struct stat before = inspect_regular(descriptor, 0500, 1, "SELF_CUSTODY_MISMATCH");
  char digest[65];
  digest_fd(descriptor, digest);
  struct stat after;
  if (fstat(descriptor, &after) != 0 || !same_stat(&before, &after)) {
    fail(EXIT_CUSTODY, "SELF_CUSTODY_MISMATCH");
  }
  if (strcmp(digest, expected) != 0) fail(EXIT_CUSTODY, "SELF_DIGEST_MISMATCH");
  if (lseek(descriptor, 0, SEEK_SET) < 0) fail(EXIT_CUSTODY, "SELF_CUSTODY_MISMATCH");
  return descriptor;
}

static int open_lock(const char *target, int desired_descriptor) {
  int descriptor = open(target, O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
  if (descriptor < 0) fail(EXIT_LOCK, "LOCK_OPEN_FAILED");
  inspect_regular(descriptor, 0600, 1, "LOCK_CUSTODY_MISMATCH");
  if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) fail(EXIT_LOCK, "LOCK_BUSY");
  if (descriptor != desired_descriptor) {
    if (dup2(descriptor, desired_descriptor) < 0) fail(EXIT_LOCK, "LOCK_DUP_FAILED");
    close(descriptor);
    descriptor = desired_descriptor;
  }
  int flags = fcntl(descriptor, F_GETFD);
  if (flags < 0 || fcntl(descriptor, F_SETFD, flags & ~FD_CLOEXEC) < 0) fail(EXIT_LOCK, "LOCK_INHERIT_FAILED");
  return descriptor;
}

static void reap_process_group(pid_t child) {
  int status = 0;
  for (;;) {
    pid_t result = waitpid(-child, &status, 0);
    if (result > 0) continue;
    if (result < 0 && errno == EINTR) continue;
    if (result < 0 && errno == ECHILD) return;
    fail(EXIT_CHILD, "PROCESS_GROUP_REAP_FAILED");
  }
}

static void terminate_process_group(pid_t child, int leader_reaped) {
  if (kill(-child, SIGKILL) != 0 && errno != ESRCH) fail(EXIT_CHILD, "PROCESS_GROUP_KILL_FAILED");
  if (!leader_reaped) {
    int status = 0;
    while (waitpid(child, &status, 0) < 0) {
      if (errno != EINTR) fail(EXIT_CHILD, "WAIT_FAILED");
    }
  }
  reap_process_group(child);
  if (kill(-child, 0) == 0 || errno == EPERM) fail(EXIT_CHILD, "PROCESS_GROUP_SURVIVED");
  if (errno != ESRCH) fail(EXIT_CHILD, "PROCESS_GROUP_CHECK_FAILED");
}

static void wait_for_child(pid_t child) {
  struct timespec started;
  if (clock_gettime(CLOCK_MONOTONIC, &started) != 0) fail(EXIT_CHILD, "CLOCK_FAILED");
  for (;;) {
    int status = 0;
    pid_t result = waitpid(child, &status, WNOHANG);
    if (result == child) {
      if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        if (kill(-child, 0) == 0 || errno == EPERM) {
          terminate_process_group(child, 1);
          fail(EXIT_CHILD, "RUNTIME_DESCENDANT_SURVIVED");
        }
        if (errno != ESRCH) fail(EXIT_CHILD, "PROCESS_GROUP_CHECK_FAILED");
        return;
      }
      terminate_process_group(child, 1);
      fail(EXIT_CHILD, "RUNTIME_FAILED");
    }
    if (result < 0 && errno != EINTR) fail(EXIT_CHILD, "WAIT_FAILED");
    struct timespec current;
    if (clock_gettime(CLOCK_MONOTONIC, &current) != 0) fail(EXIT_CHILD, "CLOCK_FAILED");
    if (current.tv_sec - started.tv_sec >= CHILD_TIMEOUT_SECONDS) {
      terminate_process_group(child, 0);
      fail(EXIT_CHILD, "RUNTIME_TIMEOUT");
    }
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 100000000L };
    while (nanosleep(&pause, &pause) != 0 && errno == EINTR) {}
  }
}

static void run_runtime(const options *configuration, int node_descriptor, int runtime_descriptor,
  const char *runtime_action, int include_release_lock) {
  if (fcntl(runtime_descriptor, F_SETFD, 0) < 0 || fcntl(node_descriptor, F_SETFD, 0) < 0) {
    fail(EXIT_CHILD, "EXECUTABLE_INHERIT_FAILED");
  }
  char runtime_path[64];
  snprintf(runtime_path, sizeof(runtime_path), "/proc/self/fd/%d", runtime_descriptor);
  char *arguments[22];
  int count = 0;
  arguments[count++] = (char *)NODE_PATH;
  arguments[count++] = runtime_path;
  arguments[count++] = (char *)runtime_action;
  arguments[count++] = "--bundle";
  arguments[count++] = (char *)configuration->bundle;
  arguments[count++] = "--manifest-sha256";
  arguments[count++] = (char *)configuration->manifest_sha256;
  arguments[count++] = "--attempt-id";
  arguments[count++] = (char *)configuration->attempt_id;
  if (strcmp(runtime_action, "inspect") != 0 && strcmp(runtime_action, "verify") != 0) {
    arguments[count++] = "--global-lock-fd";
    arguments[count++] = "3";
    arguments[count++] = "--nginx-lock-fd";
    arguments[count++] = "5";
    if (include_release_lock) {
      arguments[count++] = "--release-lock-fd";
      arguments[count++] = "4";
    }
  }
  arguments[count] = NULL;

  char guard_environment[100];
  snprintf(guard_environment, sizeof(guard_environment), "LK_FRONTEND_BOOTSTRAP_GUARD_SHA256=%s",
    configuration->expected_self_sha256);
  char guard_fd_environment[] = "LK_FRONTEND_BOOTSTRAP_GUARD_FD=6";
  char authority_environment[128];
  char *environment[6] = { "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", guard_environment,
    guard_fd_environment, NULL, NULL };
  if (strcmp(runtime_action, "inspect") != 0 && strcmp(runtime_action, "verify") != 0
    && configuration->authority != NULL && strcmp(configuration->authority, "-") != 0) {
    const char *key = NULL;
    if (strcmp(configuration->action, "apply") == 0) key = "LK_FRONTEND_BOOTSTRAP_APPLY";
    else if (strcmp(configuration->action, "recover") == 0) key = "LK_FRONTEND_BOOTSTRAP_RECOVER";
    else if (strcmp(configuration->action, "rollback") == 0) key = "LK_FRONTEND_BOOTSTRAP_ROLLBACK";
    else if (strcmp(configuration->action, "finalize") == 0) key = "LK_FRONTEND_BOOTSTRAP_FINALIZE";
    if (key == NULL || snprintf(authority_environment, sizeof(authority_environment), "%s=%s", key,
      configuration->authority) >= (int)sizeof(authority_environment)) fail(EXIT_ARGUMENT, "AUTHORITY_INVALID");
    environment[4] = authority_environment;
  }

  pid_t child = fork();
  if (child < 0) fail(EXIT_CHILD, "FORK_FAILED");
  if (child == 0) {
    if (setpgid(0, 0) != 0) _exit(126);
    fexecve(node_descriptor, arguments, environment);
    perror("NODE_FEXECVE_FAILED");
    _exit(127);
  }
  if (setpgid(child, child) != 0 && errno != EACCES && errno != ESRCH) {
    terminate_process_group(child, 0);
    fail(EXIT_CHILD, "PROCESS_GROUP_CREATE_FAILED");
  }
  wait_for_child(child);
}

static int valid_action(const char *action) {
  return action != NULL && (!strcmp(action, "preflight") || !strcmp(action, "apply")
    || !strcmp(action, "recover") || !strcmp(action, "rollback") || !strcmp(action, "finalize"));
}

static const char *expected_authority(const char *action) {
  if (!strcmp(action, "preflight")) return "-";
  if (!strcmp(action, "apply")) return "CONFIRM_EXACT_BOOTSTRAP";
  if (!strcmp(action, "recover")) return "CONFIRM_EXACT_BOOTSTRAP_RECOVERY";
  if (!strcmp(action, "rollback")) return "CONFIRM_EXACT_BOOTSTRAP_ROLLBACK";
  if (!strcmp(action, "finalize")) return "CONFIRM_EXACT_BOOTSTRAP_FINALIZE";
  return NULL;
}

static void run_mode(const options *configuration, int self_descriptor) {
  if (!valid_action(configuration->action) || !hex64(configuration->manifest_sha256)
    || !hex64(configuration->runtime_sha256) || !hex64(configuration->node_sha256)
    || configuration->bundle == NULL || configuration->authority == NULL
    || strcmp(configuration->authority, expected_authority(configuration->action)) != 0) {
    fail(EXIT_ARGUMENT, "RUN_CONTRACT_MISMATCH");
  }
  char expected_bundle[256];
  if (snprintf(expected_bundle, sizeof(expected_bundle), "/root/.padlhub-frontend-bootstrap-%s",
    configuration->manifest_sha256) >= (int)sizeof(expected_bundle)
    || strcmp(configuration->bundle, expected_bundle) != 0) fail(EXIT_ARGUMENT, "BUNDLE_IDENTITY_MISMATCH");
  struct stat root;
  if (lstat(expected_bundle, &root) != 0 || !S_ISDIR(root.st_mode) || root.st_uid != 0 || root.st_gid != 0
    || (root.st_mode & 0777) != 0700) fail(EXIT_CUSTODY, "BUNDLE_CUSTODY_MISMATCH");
  char payload_path[320];
  if (snprintf(payload_path, sizeof(payload_path), "%s/payload", expected_bundle)
    >= (int)sizeof(payload_path)) fail(EXIT_ARGUMENT, "PAYLOAD_PATH_INVALID");
  struct stat payload;
  if (lstat(payload_path, &payload) != 0 || !S_ISDIR(payload.st_mode) || payload.st_uid != 0
    || payload.st_gid != 0 || (payload.st_mode & 0777) != 0700) {
    fail(EXIT_CUSTODY, "PAYLOAD_CUSTODY_MISMATCH");
  }
  char runtime_path[320];
  if (snprintf(runtime_path, sizeof(runtime_path), "%s/payload/runtime.mjs", expected_bundle)
    >= (int)sizeof(runtime_path)) fail(EXIT_ARGUMENT, "RUNTIME_PATH_INVALID");
  int runtime_descriptor = move_descriptor_high(open_verified(runtime_path,
    configuration->runtime_sha256, 0500, 1, "RUNTIME_CUSTODY_MISMATCH"), "RUNTIME_DESCRIPTOR_FAILED");
  int node_descriptor = move_descriptor_high(open_verified(NODE_PATH,
    configuration->node_sha256, 0, 0, "NODE_CUSTODY_MISMATCH"), "NODE_DESCRIPTOR_FAILED");
  if (self_descriptor != 6) {
    if (dup2(self_descriptor, 6) < 0) fail(EXIT_CUSTODY, "SELF_DESCRIPTOR_FAILED");
    close(self_descriptor);
  }
  int self_flags = fcntl(6, F_GETFD);
  if (self_flags < 0 || fcntl(6, F_SETFD, self_flags & ~FD_CLOEXEC) < 0) {
    fail(EXIT_CUSTODY, "SELF_DESCRIPTOR_FAILED");
  }

  if (!strcmp(configuration->action, "preflight")) {
    run_runtime(configuration, node_descriptor, runtime_descriptor, "inspect", 0);
    return;
  }
  run_runtime(configuration, node_descriptor, runtime_descriptor, "verify", 0);
  open_lock(GLOBAL_LOCK, 3);
  open_lock(NGINX_LOCK, 5);
  if (!strcmp(configuration->action, "apply")) {
    run_runtime(configuration, node_descriptor, runtime_descriptor, "initialize", 0);
  } else if (!strcmp(configuration->action, "recover")) {
    run_runtime(configuration, node_descriptor, runtime_descriptor, "prepare-recovery", 0);
  }
  open_lock(RELEASE_LOCK, 4);
  run_runtime(configuration, node_descriptor, runtime_descriptor, configuration->action, 1);
}

static void exchange_back(int directory, const char *replacement_name) {
  if (syscall(SYS_renameat2, directory, NGINX_NAME, directory, replacement_name, RENAME_EXCHANGE) != 0
    || fsync(directory) != 0) fail(EXIT_EXCHANGE, "EXCHANGE_RESTORE_FAILED");
}

static void exchange_mode(const options *configuration) {
  if (configuration->replacement == NULL || !hex64(configuration->expected_current_sha256)
    || !hex64(configuration->expected_replacement_sha256)) fail(EXIT_ARGUMENT, "EXCHANGE_CONTRACT_MISMATCH");
  char expected_replacement[256];
  if (snprintf(expected_replacement, sizeof(expected_replacement), "%s/.%s.%s.tmp", NGINX_DIRECTORY,
    NGINX_NAME, configuration->attempt_id) >= (int)sizeof(expected_replacement)
    || strcmp(configuration->replacement, expected_replacement) != 0) fail(EXIT_ARGUMENT, "REPLACEMENT_PATH_MISMATCH");
  int directory = open(NGINX_DIRECTORY, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0) fail(EXIT_CUSTODY, "NGINX_DIRECTORY_OPEN_FAILED");
  struct stat directory_stat;
  if (fstat(directory, &directory_stat) != 0 || !S_ISDIR(directory_stat.st_mode)
    || directory_stat.st_uid != 0 || directory_stat.st_gid != 0 || (directory_stat.st_mode & 0022) != 0) {
    fail(EXIT_CUSTODY, "NGINX_DIRECTORY_CUSTODY_MISMATCH");
  }
  char replacement_name[128];
  snprintf(replacement_name, sizeof(replacement_name), ".%s.%s.tmp", NGINX_NAME, configuration->attempt_id);
  int current = openat(directory, NGINX_NAME, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  int replacement = openat(directory, replacement_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0 || replacement < 0) fail(EXIT_CUSTODY, "EXCHANGE_INPUT_OPEN_FAILED");
  struct stat current_before = inspect_regular(current, 0, 0, "NGINX_CONFIG_CUSTODY_MISMATCH");
  struct stat replacement_before = inspect_regular(replacement, 0, 0, "NGINX_REPLACEMENT_CUSTODY_MISMATCH");
  if (current_before.st_dev != replacement_before.st_dev
    || (current_before.st_mode & 0777) != (replacement_before.st_mode & 0777)) {
    fail(EXIT_CUSTODY, "EXCHANGE_INPUT_CUSTODY_MISMATCH");
  }
  char digest[65];
  digest_fd(current, digest);
  if (strcmp(digest, configuration->expected_current_sha256) != 0) fail(EXIT_EXCHANGE, "CURRENT_DIGEST_MISMATCH");
  digest_fd(replacement, digest);
  if (strcmp(digest, configuration->expected_replacement_sha256) != 0) fail(EXIT_EXCHANGE, "REPLACEMENT_DIGEST_MISMATCH");
  if (syscall(SYS_renameat2, directory, NGINX_NAME, directory, replacement_name, RENAME_EXCHANGE) != 0
    || fsync(directory) != 0) fail(EXIT_EXCHANGE, "EXCHANGE_FAILED");

  int current_after = openat(directory, NGINX_NAME, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  int replacement_after = openat(directory, replacement_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (current_after < 0 || replacement_after < 0) {
    exchange_back(directory, replacement_name);
    fail(EXIT_EXCHANGE, "EXCHANGE_POSTCHECK_OPEN_FAILED");
  }
  struct stat current_result, replacement_result;
  int valid = fstat(current_after, &current_result) == 0 && fstat(replacement_after, &replacement_result) == 0
    && S_ISREG(current_result.st_mode) && S_ISREG(replacement_result.st_mode)
    && current_result.st_uid == 0 && current_result.st_gid == 0 && current_result.st_nlink == 1
    && replacement_result.st_uid == 0 && replacement_result.st_gid == 0 && replacement_result.st_nlink == 1
    && (current_result.st_mode & 0022) == 0 && (replacement_result.st_mode & 0022) == 0;
  valid = valid && try_digest_fd(current_after, digest)
    && strcmp(digest, configuration->expected_replacement_sha256) == 0
    && current_result.st_dev == replacement_before.st_dev && current_result.st_ino == replacement_before.st_ino;
  valid = valid && try_digest_fd(replacement_after, digest)
    && strcmp(digest, configuration->expected_current_sha256) == 0
    && replacement_result.st_dev == current_before.st_dev && replacement_result.st_ino == current_before.st_ino;
  if (!valid) {
    exchange_back(directory, replacement_name);
    fail(EXIT_EXCHANGE, "EXCHANGE_POSTCHECK_MISMATCH");
  }
  if (unlinkat(directory, replacement_name, 0) != 0) {
    exchange_back(directory, replacement_name);
    fail(EXIT_EXCHANGE, "EXCHANGE_CLEANUP_FAILED");
  }
  if (fsync(directory) != 0) {
    fail(EXIT_EXCHANGE, "EXCHANGE_CLEANUP_FAILED");
  }
  printf("{\"state\":\"EXCHANGED\"}\n");
}

int main(int argc, char **argv) {
  umask(0077);
  if (geteuid() != 0 || getegid() != 0) fail(EXIT_CUSTODY, "ROOT_REQUIRED");
  mark_inherited_descriptors_close_on_exec();
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) fail(EXIT_CHILD, "SUBREAPER_FAILED");
  options configuration = parse_options(argc, argv);
  int self_descriptor = move_descriptor_high(verify_self(configuration.expected_self_sha256),
    "SELF_DESCRIPTOR_FAILED");
  if (!strcmp(configuration.mode, "run")) run_mode(&configuration, self_descriptor);
  else {
    close(self_descriptor);
    exchange_mode(&configuration);
  }
  return 0;
}
