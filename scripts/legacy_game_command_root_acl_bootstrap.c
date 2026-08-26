#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/magic.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <time.h>
#include <unistd.h>

#define EXIT_ARGUMENT 64
#define EXIT_PRECONDITION 65
#define EXIT_CUSTODY 66
#define EXIT_XATTR 67
#define EXIT_MUTATION 68
#define EXIT_POSTCHECK 69

#define APPLY_SENTINEL "APPLY_ROOT_MODE_0755_V1"
#define ROLLBACK_SENTINEL "ROLLBACK_ROOT_MODE_0707_V1"
#define REHEARSAL_SENTINEL "MUTATE_REHEARSAL_TARGET_V1"

typedef struct {
  uint32_t state[8];
  uint64_t bit_count;
  uint8_t buffer[64];
  size_t buffer_length;
} sha256_context;

typedef struct {
  const char *mode;
  const char *environment;
  const char *target;
  const char *expected_self_sha256;
  const char *evidence_name;
  uint64_t expected_cwd_device;
  uint64_t expected_cwd_inode;
  uint64_t expected_cwd_mount_id;
  uint64_t expected_cwd_mount_flags;
  uint64_t expected_target_device;
  uint64_t expected_target_inode;
  uint64_t expected_target_mount_id;
  uint64_t expected_target_mount_flags;
  unsigned expected_mode;
  unsigned target_mode;
  unsigned rehearsal_pause_ms;
  unsigned rehearsal_pause_after_mutation_ms;
  int has_expected_cwd;
  int has_expected_cwd_mount;
  int has_expected_target;
  int has_expected_target_mount;
  int has_expected_mode;
  int has_target_mode;
} options;

typedef struct {
  uint64_t device;
  uint64_t inode;
  uint64_t uid;
  uint64_t gid;
  unsigned mode;
  unsigned link_count;
  uint64_t fs_magic;
  uint64_t mount_id;
  uint64_t mount_flags;
  unsigned device_major;
  unsigned device_minor;
  ssize_t xattr_bytes;
} snapshot;

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
    uint32_t s0 = rotate_right(words[index - 15], 7) ^ rotate_right(words[index - 15], 18) ^ (words[index - 15] >> 3);
    uint32_t s1 = rotate_right(words[index - 2], 17) ^ rotate_right(words[index - 2], 19) ^ (words[index - 2] >> 10);
    words[index] = words[index - 16] + s0 + words[index - 7] + s1;
  }

  uint32_t a = context->state[0];
  uint32_t b = context->state[1];
  uint32_t c = context->state[2];
  uint32_t d = context->state[3];
  uint32_t e = context->state[4];
  uint32_t f = context->state[5];
  uint32_t g = context->state[6];
  uint32_t h = context->state[7];
  for (size_t index = 0; index < 64; index += 1) {
    uint32_t sum1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
    uint32_t choice = (e & f) ^ ((~e) & g);
    uint32_t temporary1 = h + sum1 + choice + sha256_constants[index] + words[index];
    uint32_t sum0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t temporary2 = sum0 + majority;
    h = g;
    g = f;
    f = e;
    e = d + temporary1;
    d = c;
    c = b;
    b = a;
    a = temporary1 + temporary2;
  }
  context->state[0] += a;
  context->state[1] += b;
  context->state[2] += c;
  context->state[3] += d;
  context->state[4] += e;
  context->state[5] += f;
  context->state[6] += g;
  context->state[7] += h;
}

static void sha256_init(sha256_context *context) {
  memset(context, 0, sizeof(*context));
  context->state[0] = 0x6a09e667U;
  context->state[1] = 0xbb67ae85U;
  context->state[2] = 0x3c6ef372U;
  context->state[3] = 0xa54ff53aU;
  context->state[4] = 0x510e527fU;
  context->state[5] = 0x9b05688cU;
  context->state[6] = 0x1f83d9abU;
  context->state[7] = 0x5be0cd19U;
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

static void fail_fixed(int exit_code, const char *code) {
  fprintf(stderr, "%s\n", code);
  exit(exit_code);
}

static uint64_t parse_u64(const char *value, const char *code) {
  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') fail_fixed(EXIT_ARGUMENT, code);
  return (uint64_t)parsed;
}

static unsigned parse_mode(const char *value, const char *code) {
  char *end = NULL;
  errno = 0;
  unsigned long parsed = strtoul(value, &end, 8);
  if (errno != 0 || end == value || *end != '\0' || parsed > 0777U) fail_fixed(EXIT_ARGUMENT, code);
  return (unsigned)parsed;
}

static int is_hex_sha256(const char *value) {
  if (value == NULL || strlen(value) != 64) return 0;
  for (size_t index = 0; index < 64; index += 1) {
    char character = value[index];
    if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return 0;
  }
  return 1;
}

static int safe_path(const char *value) {
  if (value == NULL || value[0] != '/') return 0;
  for (const char *cursor = value; *cursor != '\0'; cursor += 1) {
    char character = *cursor;
    if (!((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
      || (character >= '0' && character <= '9') || character == '/' || character == '_' || character == '-' || character == '.')) return 0;
  }
  return strstr(value, "..") == NULL;
}

static int safe_evidence_name(const char *value) {
  if (value == NULL || value[0] == '\0' || strcmp(value, ".") == 0 || strcmp(value, "..") == 0) return 0;
  for (const char *cursor = value; *cursor != '\0'; cursor += 1) {
    char character = *cursor;
    if (!((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
      || (character >= '0' && character <= '9') || character == '_' || character == '-' || character == '.')) return 0;
  }
  return 1;
}

static void mark_argument_seen(uint32_t *seen, uint32_t bit) {
  if ((*seen & bit) != 0U) fail_fixed(EXIT_ARGUMENT, "DUPLICATE_ARGUMENT");
  *seen |= bit;
}

static options parse_options(int argc, char **argv) {
  options result;
  uint32_t seen = 0;
  memset(&result, 0, sizeof(result));
  for (int index = 1; index < argc; index += 2) {
    if (index + 1 >= argc) fail_fixed(EXIT_ARGUMENT, "ARGUMENT_PAIR_REQUIRED");
    const char *key = argv[index];
    const char *value = argv[index + 1];
    if (strcmp(key, "--mode") == 0) { mark_argument_seen(&seen, 1U << 0); result.mode = value; }
    else if (strcmp(key, "--environment") == 0) { mark_argument_seen(&seen, 1U << 1); result.environment = value; }
    else if (strcmp(key, "--target") == 0) { mark_argument_seen(&seen, 1U << 2); result.target = value; }
    else if (strcmp(key, "--expected-self-sha256") == 0) { mark_argument_seen(&seen, 1U << 3); result.expected_self_sha256 = value; }
    else if (strcmp(key, "--expected-cwd-device") == 0) { mark_argument_seen(&seen, 1U << 4); result.expected_cwd_device = parse_u64(value, "INVALID_CWD_DEVICE"); result.has_expected_cwd |= 1; }
    else if (strcmp(key, "--expected-cwd-inode") == 0) { mark_argument_seen(&seen, 1U << 5); result.expected_cwd_inode = parse_u64(value, "INVALID_CWD_INODE"); result.has_expected_cwd |= 2; }
    else if (strcmp(key, "--expected-target-device") == 0) { mark_argument_seen(&seen, 1U << 6); result.expected_target_device = parse_u64(value, "INVALID_TARGET_DEVICE"); result.has_expected_target |= 1; }
    else if (strcmp(key, "--expected-target-inode") == 0) { mark_argument_seen(&seen, 1U << 7); result.expected_target_inode = parse_u64(value, "INVALID_TARGET_INODE"); result.has_expected_target |= 2; }
    else if (strcmp(key, "--expected-mode") == 0) { mark_argument_seen(&seen, 1U << 8); result.expected_mode = parse_mode(value, "INVALID_EXPECTED_MODE"); result.has_expected_mode = 1; }
    else if (strcmp(key, "--target-mode") == 0) { mark_argument_seen(&seen, 1U << 9); result.target_mode = parse_mode(value, "INVALID_TARGET_MODE"); result.has_target_mode = 1; }
    else if (strcmp(key, "--rehearsal-pause-ms") == 0) {
      mark_argument_seen(&seen, 1U << 10);
      uint64_t parsed = parse_u64(value, "INVALID_REHEARSAL_PAUSE");
      if (parsed > 5000U) fail_fixed(EXIT_ARGUMENT, "INVALID_REHEARSAL_PAUSE");
      result.rehearsal_pause_ms = (unsigned)parsed;
    } else if (strcmp(key, "--expected-cwd-mount-id") == 0) {
      mark_argument_seen(&seen, 1U << 11); result.expected_cwd_mount_id = parse_u64(value, "INVALID_CWD_MOUNT_ID"); result.has_expected_cwd_mount |= 1;
    } else if (strcmp(key, "--expected-cwd-mount-flags") == 0) {
      mark_argument_seen(&seen, 1U << 12); result.expected_cwd_mount_flags = parse_u64(value, "INVALID_CWD_MOUNT_FLAGS"); result.has_expected_cwd_mount |= 2;
    } else if (strcmp(key, "--expected-target-mount-id") == 0) {
      mark_argument_seen(&seen, 1U << 13); result.expected_target_mount_id = parse_u64(value, "INVALID_TARGET_MOUNT_ID"); result.has_expected_target_mount |= 1;
    } else if (strcmp(key, "--expected-target-mount-flags") == 0) {
      mark_argument_seen(&seen, 1U << 14); result.expected_target_mount_flags = parse_u64(value, "INVALID_TARGET_MOUNT_FLAGS"); result.has_expected_target_mount |= 2;
    } else if (strcmp(key, "--evidence-name") == 0) {
      mark_argument_seen(&seen, 1U << 15); result.evidence_name = value;
    } else if (strcmp(key, "--rehearsal-pause-after-mutation-ms") == 0) {
      mark_argument_seen(&seen, 1U << 16);
      uint64_t parsed = parse_u64(value, "INVALID_REHEARSAL_POST_MUTATION_PAUSE");
      if (parsed > 5000U) fail_fixed(EXIT_ARGUMENT, "INVALID_REHEARSAL_POST_MUTATION_PAUSE");
      result.rehearsal_pause_after_mutation_ms = (unsigned)parsed;
    } else fail_fixed(EXIT_ARGUMENT, "UNKNOWN_ARGUMENT");
  }
  if (result.mode == NULL || result.environment == NULL || result.target == NULL || !is_hex_sha256(result.expected_self_sha256)) {
    fail_fixed(EXIT_ARGUMENT, "REQUIRED_ARGUMENT_MISSING");
  }
  if (!(strcmp(result.mode, "audit") == 0 || strcmp(result.mode, "apply") == 0 || strcmp(result.mode, "rollback") == 0)) {
    fail_fixed(EXIT_ARGUMENT, "INVALID_MODE");
  }
  if (!(strcmp(result.environment, "production") == 0 || strcmp(result.environment, "rehearsal") == 0)) {
    fail_fixed(EXIT_ARGUMENT, "INVALID_ENVIRONMENT");
  }
  if (!safe_path(result.target)) fail_fixed(EXIT_ARGUMENT, "INVALID_TARGET_PATH");
  int mutating = strcmp(result.mode, "audit") != 0;
  if (strcmp(result.environment, "production") == 0) {
    if (strcmp(result.target, "/") != 0 || result.rehearsal_pause_ms != 0
      || result.rehearsal_pause_after_mutation_ms != 0) fail_fixed(EXIT_ARGUMENT, "PRODUCTION_SCOPE_REJECTED");
  } else if (strcmp(result.target, "/") == 0 || strncmp(result.target, "/rehearsal/", 11) != 0) {
    fail_fixed(EXIT_ARGUMENT, "REHEARSAL_SCOPE_REJECTED");
  }
  if (mutating) {
    if (result.has_expected_cwd != 3 || result.has_expected_target != 3 || !result.has_expected_mode || !result.has_target_mode) {
      fail_fixed(EXIT_ARGUMENT, "MUTATION_PREIMAGE_REQUIRED");
    }
    if (!safe_evidence_name(result.evidence_name)) fail_fixed(EXIT_ARGUMENT, "MUTATION_EVIDENCE_NAME_REQUIRED");
    if (strcmp(result.environment, "production") == 0
      && (result.has_expected_cwd_mount != 3 || result.has_expected_target_mount != 3)) {
      fail_fixed(EXIT_ARGUMENT, "PRODUCTION_MOUNT_PREIMAGE_REQUIRED");
    }
    if (strcmp(result.mode, "apply") == 0 && !(result.expected_mode == 0707U && result.target_mode == 0755U)) {
      fail_fixed(EXIT_ARGUMENT, "APPLY_TRANSITION_REJECTED");
    }
    if (strcmp(result.mode, "rollback") == 0 && !(result.expected_mode == 0755U && result.target_mode == 0707U)) {
      fail_fixed(EXIT_ARGUMENT, "ROLLBACK_TRANSITION_REJECTED");
    }
  } else if (result.rehearsal_pause_ms != 0 || result.rehearsal_pause_after_mutation_ms != 0
    || result.evidence_name != NULL || result.has_expected_cwd != 0 || result.has_expected_target != 0
    || result.has_expected_cwd_mount != 0 || result.has_expected_target_mount != 0
    || result.has_expected_mode || result.has_target_mode) {
    fail_fixed(EXIT_ARGUMENT, "AUDIT_MUTATION_ARGUMENT_REJECTED");
  }
  return result;
}

static void digest_fd(int descriptor, char output[65]) {
  if (lseek(descriptor, 0, SEEK_SET) < 0) fail_fixed(EXIT_CUSTODY, "SELF_DIGEST_SEEK_FAILED");
  sha256_context context;
  sha256_init(&context);
  uint8_t buffer[16384];
  for (;;) {
    ssize_t length = read(descriptor, buffer, sizeof(buffer));
    if (length < 0) {
      if (errno == EINTR) continue;
      fail_fixed(EXIT_CUSTODY, "SELF_DIGEST_READ_FAILED");
    }
    if (length == 0) break;
    sha256_update(&context, buffer, (size_t)length);
  }
  uint8_t digest[32];
  sha256_final(&context, digest);
  static const char hex[] = "0123456789abcdef";
  for (size_t index = 0; index < sizeof(digest); index += 1) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 15U];
  }
  output[64] = '\0';
}

static snapshot inspect_descriptor(int descriptor, int require_empty_xattrs) {
  struct stat status;
  struct statfs filesystem;
  struct statx extended;
  memset(&extended, 0, sizeof(extended));
  if (fstat(descriptor, &status) != 0 || fstatfs(descriptor, &filesystem) != 0
    || statx(descriptor, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_MNT_ID, &extended) != 0
    || (extended.stx_mask & STATX_MNT_ID) == 0U) {
    fail_fixed(EXIT_PRECONDITION, "TARGET_STAT_FAILED");
  }
  snapshot result = {
    .device = (uint64_t)status.st_dev,
    .inode = (uint64_t)status.st_ino,
    .uid = (uint64_t)status.st_uid,
    .gid = (uint64_t)status.st_gid,
    .mode = (unsigned)(status.st_mode & 07777U),
    .link_count = (unsigned)status.st_nlink,
    .fs_magic = (uint64_t)filesystem.f_type,
    .mount_id = (uint64_t)extended.stx_mnt_id,
    .mount_flags = (uint64_t)filesystem.f_flags,
    .device_major = major(status.st_dev),
    .device_minor = minor(status.st_dev),
    .xattr_bytes = flistxattr(descriptor, NULL, 0),
  };
  if (result.xattr_bytes < 0) fail_fixed(EXIT_XATTR, "XATTR_READ_FAILED");
  if (require_empty_xattrs && result.xattr_bytes != 0) fail_fixed(EXIT_XATTR, "XATTR_SET_NOT_EMPTY");
  ssize_t repeated = flistxattr(descriptor, NULL, 0);
  if (repeated < 0 || repeated != result.xattr_bytes) fail_fixed(EXIT_XATTR, "XATTR_READ_DRIFT");
  return result;
}

static void require_root_identity(void) {
  if (getuid() != 0 || geteuid() != 0 || getgid() != 0 || getegid() != 0) {
    fail_fixed(EXIT_PRECONDITION, "ROOT_IDENTITY_REQUIRED");
  }
}

static snapshot verify_custody(const options *configuration, char self_sha256[65], int *cwd_descriptor) {
  int executable = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
  if (executable < 0) fail_fixed(EXIT_CUSTODY, "SELF_OPEN_FAILED");
  struct stat executable_status;
  snapshot executable_snapshot = inspect_descriptor(executable, 1);
  if (fstat(executable, &executable_status) != 0 || !S_ISREG(executable_status.st_mode)
    || executable_snapshot.uid != 0 || executable_snapshot.gid != 0
    || executable_snapshot.mode != 0500U || executable_snapshot.link_count != 1) {
    close(executable);
    fail_fixed(EXIT_CUSTODY, "SELF_CUSTODY_REJECTED");
  }
  digest_fd(executable, self_sha256);
  close(executable);
  if (strcmp(self_sha256, configuration->expected_self_sha256) != 0) fail_fixed(EXIT_CUSTODY, "SELF_DIGEST_MISMATCH");

  int cwd = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (cwd < 0) fail_fixed(EXIT_CUSTODY, "CWD_OPEN_FAILED");
  snapshot result = inspect_descriptor(cwd, 1);
  if (result.uid != 0 || result.gid != 0 || result.mode != 0700U) fail_fixed(EXIT_CUSTODY, "CWD_CUSTODY_REJECTED");
  if (configuration->has_expected_cwd == 3
    && (result.device != configuration->expected_cwd_device || result.inode != configuration->expected_cwd_inode)) {
    fail_fixed(EXIT_CUSTODY, "CWD_IDENTITY_MISMATCH");
  }
  if (configuration->has_expected_cwd_mount == 3
    && (result.mount_id != configuration->expected_cwd_mount_id
      || result.mount_flags != configuration->expected_cwd_mount_flags)) {
    fail_fixed(EXIT_CUSTODY, "CWD_MOUNT_IDENTITY_MISMATCH");
  }
  *cwd_descriptor = cwd;
  return result;
}

static void require_snapshot(const snapshot *observed, const options *configuration, unsigned expected_mode) {
  if (observed->uid != 0 || observed->gid != 0 || observed->mode != expected_mode
    || observed->device != configuration->expected_target_device || observed->inode != configuration->expected_target_inode) {
    fail_fixed(EXIT_PRECONDITION, "TARGET_PREIMAGE_MISMATCH");
  }
  if (configuration->has_expected_target_mount == 3
    && (observed->mount_id != configuration->expected_target_mount_id
      || observed->mount_flags != configuration->expected_target_mount_flags)) {
    fail_fixed(EXIT_PRECONDITION, "TARGET_MOUNT_IDENTITY_MISMATCH");
  }
  if (strcmp(configuration->environment, "production") == 0 && observed->fs_magic != (uint64_t)EXT4_SUPER_MAGIC) {
    fail_fixed(EXIT_PRECONDITION, "TARGET_FILESYSTEM_REJECTED");
  }
}

static void pause_rehearsal(unsigned milliseconds) {
  if (milliseconds == 0) return;
  struct timespec requested = {
    .tv_sec = (time_t)(milliseconds / 1000U),
    .tv_nsec = (long)(milliseconds % 1000U) * 1000000L,
  };
  while (nanosleep(&requested, &requested) != 0) {
    if (errno != EINTR) fail_fixed(EXIT_PRECONDITION, "REHEARSAL_PAUSE_FAILED");
  }
}

static FILE *reserve_evidence(const options *configuration, int cwd_descriptor) {
  int descriptor = openat(cwd_descriptor, configuration->evidence_name,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) fail_fixed(EXIT_PRECONDITION, "EVIDENCE_RESERVATION_FAILED");
  struct stat status;
  snapshot evidence = inspect_descriptor(descriptor, 1);
  if (fstat(descriptor, &status) != 0 || !S_ISREG(status.st_mode)
    || evidence.uid != 0 || evidence.gid != 0 || evidence.mode != 0600U || evidence.link_count != 1) {
    close(descriptor);
    fail_fixed(EXIT_CUSTODY, "EVIDENCE_CUSTODY_REJECTED");
  }
  FILE *stream = fdopen(descriptor, "w");
  if (stream == NULL) {
    close(descriptor);
    fail_fixed(EXIT_PRECONDITION, "EVIDENCE_STREAM_FAILED");
  }
  return stream;
}

static void require_mutation_authority(const options *configuration) {
  if (strcmp(configuration->environment, "rehearsal") == 0) {
    const char *value = getenv("LK_ROOT_ACL_BOOTSTRAP_REHEARSAL");
    if (value == NULL || strcmp(value, REHEARSAL_SENTINEL) != 0
      || getenv("LK_ROOT_ACL_BOOTSTRAP_APPLY") != NULL || getenv("LK_ROOT_ACL_BOOTSTRAP_ROLLBACK") != NULL) {
      fail_fixed(EXIT_PRECONDITION, "REHEARSAL_SENTINEL_REQUIRED");
    }
    return;
  }
  const char *name = strcmp(configuration->mode, "apply") == 0
    ? "LK_ROOT_ACL_BOOTSTRAP_APPLY" : "LK_ROOT_ACL_BOOTSTRAP_ROLLBACK";
  const char *expected = strcmp(configuration->mode, "apply") == 0 ? APPLY_SENTINEL : ROLLBACK_SENTINEL;
  const char *value = getenv(name);
  const char *opposite = strcmp(configuration->mode, "apply") == 0
    ? "LK_ROOT_ACL_BOOTSTRAP_ROLLBACK" : "LK_ROOT_ACL_BOOTSTRAP_APPLY";
  if (value == NULL || strcmp(value, expected) != 0 || getenv(opposite) != NULL
    || getenv("LK_ROOT_ACL_BOOTSTRAP_REHEARSAL") != NULL) {
    fail_fixed(EXIT_PRECONDITION, "PRODUCTION_SENTINEL_REQUIRED");
  }
}

static int print_snapshot(FILE *stream, const char *name, const snapshot *value) {
  return fprintf(stream, "\"%s\":{\"device\":\"%" PRIu64 "\",\"deviceMajor\":%u,\"deviceMinor\":%u,\"inode\":\"%" PRIu64 "\""
    ",\"uid\":%" PRIu64 ",\"gid\":%" PRIu64 ",\"mode\":\"%04o\",\"linkCount\":%u,\"fsMagic\":\"0x%" PRIx64
    "\",\"mountId\":\"%" PRIu64 "\",\"mountFlags\":\"%" PRIu64
    "\",\"xattrBytes\":%zd}", name, value->device, value->device_major, value->device_minor, value->inode,
    value->uid, value->gid, value->mode, value->link_count, value->fs_magic, value->mount_id,
    value->mount_flags, value->xattr_bytes);
}

static int print_result(FILE *stream, const options *configuration, const char *self_sha256,
  const snapshot *custody, const snapshot *before, const snapshot *after, int mutation_performed) {
  if (fprintf(stream, "{\"schemaVersion\":1,\"mode\":\"%s\",\"environment\":\"%s\",\"target\":\"%s\","
    "\"selfSha256\":\"%s\",", configuration->mode, configuration->environment,
    configuration->target, self_sha256) < 0) return -1;
  if (print_snapshot(stream, "custody", custody) < 0 || fputc(',', stream) == EOF
    || print_snapshot(stream, "before", before) < 0 || fputc(',', stream) == EOF
    || print_snapshot(stream, "after", after) < 0) return -1;
  return fprintf(stream, ",\"mutationPerformed\":%s,\"postcheckComplete\":true}\n",
    mutation_performed ? "true" : "false");
}

int main(int argc, char **argv) {
  umask(077);
  options configuration = parse_options(argc, argv);
  require_root_identity();
  if (signal(SIGPIPE, SIG_IGN) == SIG_ERR) fail_fixed(EXIT_PRECONDITION, "SIGPIPE_POLICY_FAILED");
  if (prctl(PR_SET_DUMPABLE, 0) != 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fail_fixed(EXIT_PRECONDITION, "PROCESS_HARDENING_FAILED");
  }

  char self_sha256[65];
  int cwd_descriptor = -1;
  snapshot custody = verify_custody(&configuration, self_sha256, &cwd_descriptor);
  int target = open(configuration.target, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (target < 0) fail_fixed(EXIT_PRECONDITION, "TARGET_OPEN_FAILED");
  snapshot before = inspect_descriptor(target, 1);
  if (strcmp(configuration.environment, "production") == 0 && before.fs_magic != (uint64_t)EXT4_SUPER_MAGIC) {
    close(target);
    fail_fixed(EXIT_PRECONDITION, "TARGET_FILESYSTEM_REJECTED");
  }
  if (strcmp(configuration.environment, "production") == 0
    && (before.uid != 0 || before.gid != 0 || !(before.mode == 0707U || before.mode == 0755U))) {
    close(target);
    fail_fixed(EXIT_PRECONDITION, "PRODUCTION_TARGET_PREIMAGE_REJECTED");
  }

  int mutation_performed = 0;
  snapshot after = before;
  FILE *evidence_stream = NULL;
  if (strcmp(configuration.mode, "audit") != 0) {
    require_mutation_authority(&configuration);
    require_snapshot(&before, &configuration, configuration.expected_mode);
    pause_rehearsal(configuration.rehearsal_pause_ms);
    snapshot immediately_before = inspect_descriptor(target, 1);
    require_snapshot(&immediately_before, &configuration, configuration.expected_mode);
    evidence_stream = reserve_evidence(&configuration, cwd_descriptor);
    if (fchmod(target, (mode_t)configuration.target_mode) != 0) {
      fclose(evidence_stream);
      close(target);
      fail_fixed(EXIT_MUTATION, "TARGET_FCHMOD_FAILED");
    }
    mutation_performed = 1;
    pause_rehearsal(configuration.rehearsal_pause_after_mutation_ms);
    if (fsync(target) != 0) {
      close(target);
      fail_fixed(EXIT_POSTCHECK, "TARGET_FSYNC_FAILED_AFTER_MUTATION");
    }
    after = inspect_descriptor(target, 1);
    if (after.device != before.device || after.inode != before.inode || after.uid != 0 || after.gid != 0
      || after.mode != configuration.target_mode || after.fs_magic != before.fs_magic
      || after.mount_id != before.mount_id || after.mount_flags != before.mount_flags) {
      close(target);
      fail_fixed(EXIT_POSTCHECK, "TARGET_POSTCHECK_FAILED_AFTER_MUTATION");
    }
  }
  close(target);

  if (mutation_performed) {
    int evidence_descriptor = fileno(evidence_stream);
    int evidence_failed = print_result(evidence_stream, &configuration, self_sha256, &custody, &before, &after, 1) < 0
      || fflush(evidence_stream) != 0 || fsync(evidence_descriptor) != 0;
    if (fclose(evidence_stream) != 0) evidence_failed = 1;
    if (fsync(cwd_descriptor) != 0) evidence_failed = 1;
    if (evidence_failed) {
      close(cwd_descriptor);
      fail_fixed(EXIT_POSTCHECK, "EVIDENCE_WRITE_FAILED_AFTER_MUTATION");
    }
  }
  if (print_result(stdout, &configuration, self_sha256, &custody, &before, &after, mutation_performed) < 0
    || fflush(stdout) != 0) {
    close(cwd_descriptor);
    if (mutation_performed) fail_fixed(EXIT_POSTCHECK, "RESULT_OUTPUT_FAILED_AFTER_MUTATION");
    fail_fixed(EXIT_PRECONDITION, "RESULT_OUTPUT_FAILED");
  }
  close(cwd_descriptor);
  return 0;
}
