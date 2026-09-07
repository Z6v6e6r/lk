#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef CLOSE_RANGE_CLOEXEC
#define CLOSE_RANGE_CLOEXEC (1U << 2)
#endif

#define EXIT_ARGUMENT 64
#define EXIT_CUSTODY 65
#define EXIT_EXEC 66
#define NODE_PATH "/usr/bin/node"

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

typedef struct {
  uint32_t state[8];
  uint64_t bit_count;
  uint8_t buffer[64];
  size_t buffer_length;
} sha256_context;


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
    if (!((value[index] >= '0' && value[index] <= '9')
      || (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  }
  return 1;
}

static int same_stat(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino
    && left->st_uid == right->st_uid && left->st_gid == right->st_gid
    && left->st_mode == right->st_mode && left->st_nlink == right->st_nlink
    && left->st_size == right->st_size
    && left->st_mtim.tv_sec == right->st_mtim.tv_sec && left->st_mtim.tv_nsec == right->st_mtim.tv_nsec
    && left->st_ctim.tv_sec == right->st_ctim.tv_sec && left->st_ctim.tv_nsec == right->st_ctim.tv_nsec;
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


static int open_verified(const char *target, const char *expected, mode_t exact_mode,
  int require_exact_mode, const char *message, char observed[65]) {
  int descriptor = open(target, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) fail(EXIT_CUSTODY, message);
  struct stat before;
  if (fstat(descriptor, &before) != 0 || !S_ISREG(before.st_mode) || before.st_uid != 0
    || before.st_gid != 0 || before.st_nlink != 1 || (before.st_mode & 0022) != 0
    || (require_exact_mode && (before.st_mode & 0777) != exact_mode)) fail(EXIT_CUSTODY, message);
  digest_fd(descriptor, observed);
  struct stat after;
  if (fstat(descriptor, &after) != 0 || !same_stat(&before, &after)) fail(EXIT_CUSTODY, message);
  if (expected != NULL && strcmp(observed, expected) != 0) fail(EXIT_CUSTODY, "EXECUTABLE_DIGEST_MISMATCH");
  return descriptor;
}

static void verify_self(const char *expected) {
  char observed[65];
  int descriptor = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
  struct stat before;
  if (descriptor < 0 || fstat(descriptor, &before) != 0 || !S_ISREG(before.st_mode)
    || before.st_uid != 0 || before.st_gid != 0 || before.st_nlink != 1
    || (before.st_mode & 0777) != 0500) fail(EXIT_CUSTODY, "LAUNCHER_CUSTODY_MISMATCH");
  digest_fd(descriptor, observed);
  struct stat after;
  if (fstat(descriptor, &after) != 0 || !same_stat(&before, &after)) {
    fail(EXIT_CUSTODY, "LAUNCHER_CUSTODY_MISMATCH");
  }
  if (strcmp(observed, expected) != 0) fail(EXIT_CUSTODY, "EXECUTABLE_DIGEST_MISMATCH");
  close(descriptor);
}

static void inherit_descriptor(int descriptor, const char *message) {
  int flags = fcntl(descriptor, F_GETFD);
  if (flags < 0 || fcntl(descriptor, F_SETFD, flags & ~FD_CLOEXEC) < 0) fail(EXIT_EXEC, message);
}

static void launch_guard(int argc, char **argv) {
  if (argc < 6 || !hex64(argv[2]) || !hex64(argv[4])) fail(EXIT_ARGUMENT, "GUARD_ARGUMENTS_INVALID");
  verify_self(argv[2]);
  char observed[65];
  int guard = open_verified(argv[3], argv[4], 0500, 1, "GUARD_CUSTODY_MISMATCH", observed);
  inherit_descriptor(guard, "GUARD_FD_INHERIT_FAILED");
  char **arguments = calloc((size_t)argc - 3, sizeof(char *));
  if (arguments == NULL) fail(EXIT_EXEC, "ALLOCATE_FAILED");
  arguments[0] = argv[3];
  for (int index = 5; index < argc; index += 1) arguments[index - 4] = argv[index];
  char *environment[] = { "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C", NULL };
  fexecve(guard, arguments, environment);
  fail(EXIT_EXEC, "GUARD_FEXECVE_FAILED");
}

static void launch_audit(int argc, char **argv) {
  if (argc != 5 || !hex64(argv[2]) || !hex64(argv[4])) fail(EXIT_ARGUMENT, "AUDIT_ARGUMENTS_INVALID");
  verify_self(argv[2]);
  char node_sha256[65], script_sha256[65];
  int node = open_verified(NODE_PATH, NULL, 0, 0, "NODE_CUSTODY_MISMATCH", node_sha256);
  int script = open_verified(argv[3], argv[4], 0400, 1, "AUDIT_SOURCE_CUSTODY_MISMATCH", script_sha256);
  inherit_descriptor(node, "NODE_FD_INHERIT_FAILED");
  inherit_descriptor(script, "AUDIT_FD_INHERIT_FAILED");
  char script_path[64];
  snprintf(script_path, sizeof(script_path), "/proc/self/fd/%d", script);
  char source_environment[100], launcher_environment[100], node_environment[100];
  snprintf(source_environment, sizeof(source_environment), "LK_FRONTEND_AUDIT_SOURCE_SHA256=%s", script_sha256);
  snprintf(launcher_environment, sizeof(launcher_environment), "LK_FRONTEND_AUDIT_LAUNCHER_SHA256=%s", argv[2]);
  snprintf(node_environment, sizeof(node_environment), "LK_FRONTEND_AUDIT_NODE_SHA256=%s", node_sha256);
  char *arguments[] = { (char *)NODE_PATH, script_path, NULL };
  char *environment[] = { "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", "LC_ALL=C",
    source_environment, launcher_environment, node_environment, NULL };
  fexecve(node, arguments, environment);
  perror("NODE_FEXECVE_FAILED");
  fail(EXIT_EXEC, "NODE_FEXECVE_FAILED");
}

int main(int argc, char **argv) {
  umask(0077);
  if (geteuid() != 0 || getegid() != 0) fail(EXIT_CUSTODY, "ROOT_REQUIRED");
  mark_inherited_descriptors_close_on_exec();
  if (argc < 2) fail(EXIT_ARGUMENT, "MODE_REQUIRED");
  if (strcmp(argv[1], "guard") == 0) launch_guard(argc, argv);
  if (strcmp(argv[1], "audit") == 0) launch_audit(argc, argv);
  fail(EXIT_ARGUMENT, "MODE_INVALID");
  return 1;
}
