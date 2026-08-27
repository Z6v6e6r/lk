#define main legacy_game_command_h2_identity_audit_main
#include "../legacy_game_command_h2_identity_audit.c"
#undef main

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  options o = {0};
  o.environment = "production";
  o.coverage_root = "/";
  o.mount_count = 1;
  strcpy(o.mounts[0].path, "/");
  o.mounts[0].expected.mount_id = 30;
  mount_coverage coverage = validate_mount_coverage_file(&o, argv[1]);
  printf("scanned=%llu excluded=%llu\n",
    (unsigned long long)coverage.scanned,
    (unsigned long long)coverage.excluded);
  return 0;
}
