#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <inttypes.h>
#include <limits.h>
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
#define EXIT_SCAN 67
#define EXIT_EVIDENCE 68
#define MAX_MOUNTS 128
#define ACL_XATTR_VERSION 2U
#define ACL_USER 0x02U
#define ACL_GROUP 0x08U

typedef struct {
  uint32_t state[8];
  uint64_t bits;
  uint8_t buffer[64];
  size_t length;
} sha256_context;

typedef struct {
  uint64_t device;
  uint64_t inode;
  uint64_t uid;
  uint64_t gid;
  uint64_t mount_id;
  uint64_t mount_flags;
  uint64_t fs_magic;
  unsigned mode;
  unsigned links;
} snapshot;

typedef struct {
  char path[PATH_MAX];
  snapshot expected;
  int covered;
} mount_spec;

typedef struct {
  const char *environment;
  uint64_t candidate_uid;
  uint64_t candidate_gid;
  const char *expected_self_sha256;
  const char *expected_mountinfo_sha256;
  const char *evidence_name;
  const char *coverage_root;
  const char *attempt_id;
  const char *lease_sha256;
  const char *expected_hostname;
  const char *expected_boot_id;
  uint64_t issued_at_unix;
  uint64_t expires_at_unix;
  snapshot expected_cwd;
  mount_spec mounts[MAX_MOUNTS];
  size_t mount_count;
  unsigned deadline_seconds;
} options;

typedef struct {
  uint64_t objects;
  uint64_t uid_owned;
  uint64_t gid_owned;
  uint64_t access_user_acl;
  uint64_t access_group_acl;
  uint64_t default_user_acl;
  uint64_t default_group_acl;
  char inventory_sha256[65];
} scan_counts;

typedef struct {
  uint64_t processes;
  uint64_t uid_matches;
  uint64_t gid_matches;
  uint64_t supplementary_gid_matches;
  char inventory_sha256[65];
} process_counts;

typedef struct {
  uint64_t rows;
  uint64_t uid_matches;
  uint64_t gid_matches;
  char inventory_sha256[65];
} ipc_counts;

typedef struct {
  uint64_t scanned;
  uint64_t excluded;
  char inventory_sha256[65];
} mount_coverage;

static const uint32_t sha256_constants[64] = {
  0x428a2f98U,0x71374491U,0xb5c0fbcfU,0xe9b5dba5U,0x3956c25bU,0x59f111f1U,0x923f82a4U,0xab1c5ed5U,
  0xd807aa98U,0x12835b01U,0x243185beU,0x550c7dc3U,0x72be5d74U,0x80deb1feU,0x9bdc06a7U,0xc19bf174U,
  0xe49b69c1U,0xefbe4786U,0x0fc19dc6U,0x240ca1ccU,0x2de92c6fU,0x4a7484aaU,0x5cb0a9dcU,0x76f988daU,
  0x983e5152U,0xa831c66dU,0xb00327c8U,0xbf597fc7U,0xc6e00bf3U,0xd5a79147U,0x06ca6351U,0x14292967U,
  0x27b70a85U,0x2e1b2138U,0x4d2c6dfcU,0x53380d13U,0x650a7354U,0x766a0abbU,0x81c2c92eU,0x92722c85U,
  0xa2bfe8a1U,0xa81a664bU,0xc24b8b70U,0xc76c51a3U,0xd192e819U,0xd6990624U,0xf40e3585U,0x106aa070U,
  0x19a4c116U,0x1e376c08U,0x2748774cU,0x34b0bcb5U,0x391c0cb3U,0x4ed8aa4aU,0x5b9cca4fU,0x682e6ff3U,
  0x748f82eeU,0x78a5636fU,0x84c87814U,0x8cc70208U,0x90befffaU,0xa4506cebU,0xbef9a3f7U,0xc67178f2U,
};

static uint32_t ror(uint32_t v, unsigned n) { return (v >> n) | (v << (32U - n)); }
static void sha_transform(sha256_context *c, const uint8_t b[64]) {
  uint32_t w[64];
  for (size_t i=0;i<16;i++) w[i]=((uint32_t)b[i*4]<<24)|((uint32_t)b[i*4+1]<<16)|((uint32_t)b[i*4+2]<<8)|b[i*4+3];
  for (size_t i=16;i<64;i++) w[i]=w[i-16]+(ror(w[i-15],7)^ror(w[i-15],18)^(w[i-15]>>3))+w[i-7]+(ror(w[i-2],17)^ror(w[i-2],19)^(w[i-2]>>10));
  uint32_t a=c->state[0],d=c->state[3],e=c->state[4],f=c->state[5],g=c->state[6],h=c->state[7],bb=c->state[1],cc=c->state[2];
  for (size_t i=0;i<64;i++) { uint32_t t1=h+(ror(e,6)^ror(e,11)^ror(e,25))+((e&f)^((~e)&g))+sha256_constants[i]+w[i]; uint32_t t2=(ror(a,2)^ror(a,13)^ror(a,22))+((a&bb)^(a&cc)^(bb&cc)); h=g;g=f;f=e;e=d+t1;d=cc;cc=bb;bb=a;a=t1+t2; }
  c->state[0]+=a;c->state[1]+=bb;c->state[2]+=cc;c->state[3]+=d;c->state[4]+=e;c->state[5]+=f;c->state[6]+=g;c->state[7]+=h;
}
static void sha_init(sha256_context *c) { memset(c,0,sizeof(*c)); uint32_t s[8]={0x6a09e667U,0xbb67ae85U,0x3c6ef372U,0xa54ff53aU,0x510e527fU,0x9b05688cU,0x1f83d9abU,0x5be0cd19U}; memcpy(c->state,s,sizeof(s)); }
static void sha_update(sha256_context *c,const uint8_t *p,size_t n) { for(size_t i=0;i<n;i++){c->buffer[c->length++]=p[i];if(c->length==64){sha_transform(c,c->buffer);c->bits+=512;c->length=0;}} }
static void sha_final(sha256_context *c,uint8_t out[32]) { c->bits+=(uint64_t)c->length*8U;c->buffer[c->length++]=0x80U;if(c->length>56){while(c->length<64)c->buffer[c->length++]=0;sha_transform(c,c->buffer);c->length=0;}while(c->length<56)c->buffer[c->length++]=0;for(int i=7;i>=0;i--)c->buffer[c->length++]=(uint8_t)(c->bits>>(i*8));sha_transform(c,c->buffer);for(size_t i=0;i<8;i++){out[i*4]=(uint8_t)(c->state[i]>>24);out[i*4+1]=(uint8_t)(c->state[i]>>16);out[i*4+2]=(uint8_t)(c->state[i]>>8);out[i*4+3]=(uint8_t)c->state[i];}}
static void hex_digest(const uint8_t d[32],char out[65]) { static const char h[]="0123456789abcdef";for(size_t i=0;i<32;i++){out[i*2]=h[d[i]>>4];out[i*2+1]=h[d[i]&15U];}out[64]='\0'; }
static void sha_u64(sha256_context *c,uint64_t v){uint8_t b[8];for(size_t i=0;i<8;i++)b[i]=(uint8_t)(v>>(i*8));sha_update(c,b,sizeof(b));}
static void sha_bytes(sha256_context *c,const void *p,size_t n){sha_u64(c,(uint64_t)n);sha_update(c,(const uint8_t*)p,n);}
static void sha_text(sha256_context *c,const char *s){sha_bytes(c,s,strlen(s));}
static void finish_sha(sha256_context *c,char out[65]){uint8_t d[32];sha_final(c,d);hex_digest(d,out);}

static void fail(int code,const char *message) { fprintf(stderr,"%s\n",message);exit(code); }
static uint64_t u64(const char *s,const char *code) { char *e=NULL;errno=0;unsigned long long v=strtoull(s,&e,10);if(errno||e==s||*e)fail(EXIT_ARGUMENT,code);return (uint64_t)v; }
static unsigned mode_value(const char *s) { char *e=NULL;errno=0;unsigned long v=strtoul(s,&e,8);if(errno||e==s||*e||v>07777U)fail(EXIT_ARGUMENT,"INVALID_MOUNT_MODE");return (unsigned)v; }
static int hex64(const char *s) { if(!s||strlen(s)!=64)return 0;for(size_t i=0;i<64;i++)if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return 0;return 1; }
static int uuid36(const char *s) { if(!s||strlen(s)!=36)return 0;for(size_t i=0;i<36;i++){if(i==8||i==13||i==18||i==23){if(s[i]!='-')return 0;}else if(!((s[i]>='0'&&s[i]<='9')||(s[i]>='a'&&s[i]<='f')))return 0;}return 1; }
static int safe_name(const char *s) { if(!s||!*s||strstr(s,".."))return 0;for(;*s;s++)if(!( (*s>='a'&&*s<='z')||(*s>='A'&&*s<='Z')||(*s>='0'&&*s<='9')||*s=='_'||*s=='-'||*s=='.'))return 0;return 1; }
static int safe_path(const char *s) { if(!s||*s!='/'||strstr(s,".."))return 0;for(;*s;s++)if(!( (*s>='a'&&*s<='z')||(*s>='A'&&*s<='Z')||(*s>='0'&&*s<='9')||*s=='/'||*s=='_'||*s=='-'||*s=='.'))return 0;return 1; }
static int path_within(const char *path,const char *root){size_t n=strlen(root);if(!strcmp(root,"/"))return path[0]=='/';return !strncmp(path,root,n)&&(path[n]=='\0'||path[n]=='/');}
static int pseudo_filesystem(const char *s){const char *types[]={"proc","sysfs","cgroup","cgroup2","securityfs","tracefs","debugfs","configfs","efivarfs","bpf","fusectl","binfmt_misc","pstore"};for(size_t i=0;i<sizeof(types)/sizeof(types[0]);i++)if(!strcmp(s,types[i]))return 1;return 0;}
static int remote_filesystem(const char *s){return !strncmp(s,"nfs",3)||!strcmp(s,"cifs")||!strcmp(s,"smb3")||!strcmp(s,"9p")||!strcmp(s,"ceph")||!strcmp(s,"afs")||!strcmp(s,"glusterfs")||!strcmp(s,"fuse.sshfs");}
static int local_filesystem(const char *s){const char *types[]={"ext2","ext3","ext4","xfs","btrfs","tmpfs","devtmpfs","devpts","overlay","zfs","squashfs","vfat","exfat","iso9660","hugetlbfs","mqueue","ramfs","f2fs","jfs","reiserfs"};for(size_t i=0;i<sizeof(types)/sizeof(types[0]);i++)if(!strcmp(s,types[i]))return 1;return 0;}
static int approved_autofs_placeholder(const char *fstype,const char *source,const char *root,const char *path){return !strcmp(fstype,"autofs")&&!strcmp(source,"systemd-1")&&!strcmp(root,"/")&&!strcmp(path,"/proc/sys/fs/binfmt_misc");}
static int decode_mount_path(const char *encoded,char out[PATH_MAX]){size_t w=0,n=strlen(encoded);for(size_t i=0;i<n;i++){unsigned char ch=(unsigned char)encoded[i];if(ch=='\\'){if(i+3>=n||!(encoded[i+1]>='0'&&encoded[i+1]<='7'&&encoded[i+2]>='0'&&encoded[i+2]<='7'&&encoded[i+3]>='0'&&encoded[i+3]<='7'))return 0;unsigned value=(unsigned)(encoded[i+1]-'0')*64U+(unsigned)(encoded[i+2]-'0')*8U+(unsigned)(encoded[i+3]-'0');if(value==0||w+1>=PATH_MAX)return 0;out[w++]=(char)value;i+=3;}else{if(w+1>=PATH_MAX)return 0;out[w++]=(char)ch;}}out[w]='\0';return safe_path(out);}

static snapshot inspect_fd(int fd,int empty_xattrs) {
  struct stat st;struct statfs fs;struct statx sx;memset(&sx,0,sizeof(sx));
  if(fstat(fd,&st)||fstatfs(fd,&fs)||statx(fd,"",AT_EMPTY_PATH|AT_SYMLINK_NOFOLLOW,STATX_MNT_ID,&sx)||(sx.stx_mask&STATX_MNT_ID)==0)fail(EXIT_PRECONDITION,"STAT_FAILED");
  if(empty_xattrs){ssize_t n=flistxattr(fd,NULL,0);if(n<0)fail(EXIT_CUSTODY,"XATTR_READ_FAILED");if(n!=0)fail(EXIT_CUSTODY,"XATTR_SET_NOT_EMPTY");}
  snapshot r={(uint64_t)st.st_dev,(uint64_t)st.st_ino,(uint64_t)st.st_uid,(uint64_t)st.st_gid,(uint64_t)sx.stx_mnt_id,(uint64_t)fs.f_flags,(uint64_t)fs.f_type,(unsigned)(st.st_mode&07777U),(unsigned)st.st_nlink};return r;
}
static int same_snapshot(const snapshot *a,const snapshot *b) { return a->device==b->device&&a->inode==b->inode&&a->uid==b->uid&&a->gid==b->gid&&a->mount_id==b->mount_id&&a->mount_flags==b->mount_flags&&a->fs_magic==b->fs_magic&&a->mode==b->mode&&a->links==b->links; }
static void digest_fd(int fd,char out[65]) { if(lseek(fd,0,SEEK_SET)<0)fail(EXIT_CUSTODY,"DIGEST_SEEK_FAILED");sha256_context c;sha_init(&c);uint8_t b[16384];for(;;){ssize_t n=read(fd,b,sizeof(b));if(n<0){if(errno==EINTR)continue;fail(EXIT_CUSTODY,"DIGEST_READ_FAILED");}if(!n)break;sha_update(&c,b,(size_t)n);}uint8_t d[32];sha_final(&c,d);hex_digest(d,out); }
static void digest_path(const char *path,char out[65]) { int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);if(fd<0)fail(EXIT_PRECONDITION,"DIGEST_OPEN_FAILED");digest_fd(fd,out);close(fd); }

static mount_spec parse_mount(const char *value) {
  char copy[PATH_MAX+256];if(strlen(value)>=sizeof(copy))fail(EXIT_ARGUMENT,"MOUNT_SPEC_TOO_LONG");strcpy(copy,value);
  char *parts[9];size_t count=0;char *save=NULL;for(char *p=strtok_r(copy,"|",&save);p&&count<9;p=strtok_r(NULL,"|",&save))parts[count++]=p;
  if(count!=9||!safe_path(parts[0]))fail(EXIT_ARGUMENT,"INVALID_MOUNT_SPEC");
  mount_spec m;memset(&m,0,sizeof(m));strcpy(m.path,parts[0]);m.expected.device=u64(parts[1],"INVALID_MOUNT_DEVICE");m.expected.inode=u64(parts[2],"INVALID_MOUNT_INODE");m.expected.mount_id=u64(parts[3],"INVALID_MOUNT_ID");m.expected.mount_flags=u64(parts[4],"INVALID_MOUNT_FLAGS");m.expected.fs_magic=u64(parts[5],"INVALID_MOUNT_FS");m.expected.uid=u64(parts[6],"INVALID_MOUNT_UID");m.expected.gid=u64(parts[7],"INVALID_MOUNT_GID");m.expected.mode=mode_value(parts[8]);m.expected.links=0;return m;
}
static options parse_options(int argc,char **argv) {
  options o;memset(&o,0,sizeof(o));uint64_t seen=0;
  for(int i=1;i<argc;i+=2){if(i+1>=argc)fail(EXIT_ARGUMENT,"ARGUMENT_PAIR_REQUIRED");const char *k=argv[i],*v=argv[i+1];
    if(!strcmp(k,"--mount")){if(o.mount_count>=MAX_MOUNTS)fail(EXIT_ARGUMENT,"TOO_MANY_MOUNTS");mount_spec m=parse_mount(v);for(size_t n=0;n<o.mount_count;n++)if(!strcmp(o.mounts[n].path,m.path)||(m.expected.mount_id&&o.mounts[n].expected.mount_id==m.expected.mount_id))fail(EXIT_ARGUMENT,"DUPLICATE_MOUNT_SPEC");o.mounts[o.mount_count++]=m;continue;}
    uint64_t bit=0;
    if(!strcmp(k,"--environment")){bit=1ULL<<0;o.environment=v;}
    else if(!strcmp(k,"--candidate-uid")){bit=1ULL<<1;o.candidate_uid=u64(v,"INVALID_UID");}
    else if(!strcmp(k,"--candidate-gid")){bit=1ULL<<2;o.candidate_gid=u64(v,"INVALID_GID");}
    else if(!strcmp(k,"--expected-self-sha256")){bit=1ULL<<3;o.expected_self_sha256=v;}
    else if(!strcmp(k,"--expected-mountinfo-sha256")){bit=1ULL<<4;o.expected_mountinfo_sha256=v;}
    else if(!strcmp(k,"--evidence-name")){bit=1ULL<<5;o.evidence_name=v;}
    else if(!strcmp(k,"--expected-cwd-device")){bit=1ULL<<6;o.expected_cwd.device=u64(v,"INVALID_CWD_DEVICE");}
    else if(!strcmp(k,"--expected-cwd-inode")){bit=1ULL<<7;o.expected_cwd.inode=u64(v,"INVALID_CWD_INODE");}
    else if(!strcmp(k,"--expected-cwd-mount-id")){bit=1ULL<<8;o.expected_cwd.mount_id=u64(v,"INVALID_CWD_MOUNT_ID");}
    else if(!strcmp(k,"--expected-cwd-mount-flags")){bit=1ULL<<9;o.expected_cwd.mount_flags=u64(v,"INVALID_CWD_MOUNT_FLAGS");}
    else if(!strcmp(k,"--deadline-seconds")){bit=1ULL<<10;uint64_t deadline=u64(v,"INVALID_DEADLINE");if(deadline<1||deadline>7200)fail(EXIT_ARGUMENT,"INVALID_DEADLINE");o.deadline_seconds=(unsigned)deadline;}
    else if(!strcmp(k,"--coverage-root")){bit=1ULL<<11;o.coverage_root=v;}
    else if(!strcmp(k,"--attempt-id")){bit=1ULL<<12;o.attempt_id=v;}
    else if(!strcmp(k,"--lease-sha256")){bit=1ULL<<13;o.lease_sha256=v;}
    else if(!strcmp(k,"--expected-hostname")){bit=1ULL<<14;o.expected_hostname=v;}
    else if(!strcmp(k,"--expected-boot-id")){bit=1ULL<<15;o.expected_boot_id=v;}
    else if(!strcmp(k,"--issued-at-unix")){bit=1ULL<<16;o.issued_at_unix=u64(v,"INVALID_ISSUED_AT");}
    else if(!strcmp(k,"--expires-at-unix")){bit=1ULL<<17;o.expires_at_unix=u64(v,"INVALID_EXPIRES_AT");}
    else fail(EXIT_ARGUMENT,"UNKNOWN_ARGUMENT");
    if(seen&bit)fail(EXIT_ARGUMENT,"DUPLICATE_ARGUMENT");
    seen|=bit;
  }
  const uint64_t required=(1ULL<<18)-1;if((seen&required)!=required||o.mount_count==0||!hex64(o.expected_self_sha256)||!hex64(o.expected_mountinfo_sha256)||!safe_name(o.evidence_name)||!safe_path(o.coverage_root)||!uuid36(o.attempt_id)||!hex64(o.lease_sha256)||!safe_name(o.expected_hostname)||!uuid36(o.expected_boot_id))fail(EXIT_ARGUMENT,"REQUIRED_ARGUMENT_MISSING");
  if(strcmp(o.environment,"production")&&strcmp(o.environment,"rehearsal"))fail(EXIT_ARGUMENT,"INVALID_ENVIRONMENT");
  if(o.candidate_uid==0||o.candidate_gid==0)fail(EXIT_ARGUMENT,"ROOT_ID_REJECTED");
  if(!strcmp(o.environment,"production")&&(o.candidate_uid>999||o.candidate_gid>999))fail(EXIT_ARGUMENT,"SYSTEM_ID_RANGE_REJECTED");
  if(o.expires_at_unix<=o.issued_at_unix||o.expires_at_unix-o.issued_at_unix>900)fail(EXIT_ARGUMENT,"INVALID_FRESHNESS_WINDOW");
  char required_evidence[64];if(snprintf(required_evidence,sizeof(required_evidence),"%s.json",o.attempt_id)>=(int)sizeof(required_evidence)||strcmp(required_evidence,o.evidence_name))fail(EXIT_ARGUMENT,"EVIDENCE_NAME_NOT_ATTEMPT_BOUND");
  if(!strcmp(o.environment,"production")){
    if(strcmp(o.coverage_root,"/"))fail(EXIT_ARGUMENT,"PRODUCTION_COVERAGE_ROOT_REQUIRED");
    if(o.expected_cwd.device==0||o.expected_cwd.inode==0||o.expected_cwd.mount_id==0)fail(EXIT_ARGUMENT,"PRODUCTION_CWD_PINS_REQUIRED");
    for(size_t i=0;i<o.mount_count;i++)if(o.mounts[i].expected.device==0||o.mounts[i].expected.inode==0||o.mounts[i].expected.mount_id==0||o.mounts[i].expected.fs_magic==0||o.mounts[i].expected.mode==0)fail(EXIT_ARGUMENT,"PRODUCTION_MOUNT_PINS_REQUIRED");
  }
  if(!strcmp(o.environment,"rehearsal")){if(strcmp(o.coverage_root,"/rehearsal"))fail(EXIT_ARGUMENT,"REHEARSAL_COVERAGE_ROOT_REQUIRED");for(size_t i=0;i<o.mount_count;i++)if(!path_within(o.mounts[i].path,o.coverage_root))fail(EXIT_ARGUMENT,"REHEARSAL_MOUNT_REJECTED");}
  return o;
}

static uint64_t runtime_u64(const char *s,const char *code){char *end=NULL;errno=0;unsigned long long value=strtoull(s,&end,10);if(errno||end==s||*end)fail(EXIT_SCAN,code);return (uint64_t)value;}
static mount_coverage validate_mount_coverage_file(options *o,const char *mountinfo_path) {
  mount_coverage result={0};sha256_context digest;sha_init(&digest);
  if(!strcmp(o->environment,"rehearsal")){sha_text(&digest,"REHEARSAL");for(size_t i=0;i<o->mount_count;i++){sha_text(&digest,o->mounts[i].path);sha_u64(&digest,o->mounts[i].expected.mount_id);o->mounts[i].covered=1;result.scanned++;}finish_sha(&digest,result.inventory_sha256);return result;}
  FILE *f=fopen(mountinfo_path,"re");if(!f)fail(EXIT_SCAN,"MOUNTINFO_OPEN_FAILED");char *line=NULL;size_t cap=0;uint64_t seen_ids[1024],autofs_ids[1024],binfmt_parent_ids[1024];size_t seen_count=0,autofs_count=0,binfmt_count=0;
  while(getline(&line,&cap,f)>=0){if(strlen(line)>PATH_MAX*4U){free(line);fclose(f);fail(EXIT_SCAN,"MOUNTINFO_LINE_TOO_LONG");}char *separator=strstr(line," - ");if(!separator){free(line);fclose(f);fail(EXIT_SCAN,"MOUNTINFO_MALFORMED");}*separator='\0';char *right=separator+3,*right_save=NULL;char *fstype=strtok_r(right," \t\r\n",&right_save),*source=strtok_r(NULL," \t\r\n",&right_save),*super_options=strtok_r(NULL," \t\r\n",&right_save);if(!fstype||!source||!super_options){free(line);fclose(f);fail(EXIT_SCAN,"MOUNTINFO_MALFORMED");}
    char *left[256];size_t fields=0;char *left_save=NULL;for(char *token=strtok_r(line," \t\r\n",&left_save);token&&fields<256;token=strtok_r(NULL," \t\r\n",&left_save))left[fields++]=token;if(fields<6||fields==256){free(line);fclose(f);fail(EXIT_SCAN,"MOUNTINFO_MALFORMED");}
    uint64_t mount_id=runtime_u64(left[0],"MOUNTINFO_ID_INVALID"),parent_id=runtime_u64(left[1],"MOUNTINFO_PARENT_ID_INVALID");for(size_t i=0;i<seen_count;i++)if(seen_ids[i]==mount_id){free(line);fclose(f);fail(EXIT_SCAN,"MOUNTINFO_DUPLICATE_ID");}if(seen_count>=sizeof(seen_ids)/sizeof(seen_ids[0])){free(line);fclose(f);fail(EXIT_SCAN,"MOUNTINFO_TOO_MANY_MOUNTS");}seen_ids[seen_count++]=mount_id;
    for(size_t i=6;i<fields;i++)if(!strcmp(left[i],"idmapped")){free(line);fclose(f);fail(EXIT_SCAN,"IDMAPPED_MOUNT_REJECTED");}
    char mount_root[PATH_MAX],mount_path[PATH_MAX];if(!decode_mount_path(left[3],mount_root)||!decode_mount_path(left[4],mount_path)){free(line);fclose(f);fail(EXIT_SCAN,"MOUNTINFO_PATH_REJECTED");}if(!path_within(mount_path,o->coverage_root))continue;
    if(!strcmp(fstype,"binfmt_misc")&&!strcmp(source,"binfmt_misc")&&!strcmp(mount_root,"/")&&!strcmp(mount_path,"/proc/sys/fs/binfmt_misc")){if(binfmt_count>=sizeof(binfmt_parent_ids)/sizeof(binfmt_parent_ids[0])){free(line);fclose(f);fail(EXIT_SCAN,"MOUNTINFO_TOO_MANY_MOUNTS");}binfmt_parent_ids[binfmt_count++]=parent_id;}
    const char *disposition=NULL;if(approved_autofs_placeholder(fstype,source,mount_root,mount_path)){if(autofs_count>=sizeof(autofs_ids)/sizeof(autofs_ids[0])){free(line);fclose(f);fail(EXIT_SCAN,"MOUNTINFO_TOO_MANY_MOUNTS");}autofs_ids[autofs_count++]=mount_id;disposition="EXCLUDED_KERNEL_AUTOFS_PLACEHOLDER";result.excluded++;}else if(pseudo_filesystem(fstype)){disposition="EXCLUDED_KERNEL_PSEUDO";result.excluded++;}else{if(remote_filesystem(fstype)){free(line);fclose(f);fail(EXIT_SCAN,"REMOTE_MOUNT_REJECTED");}if(!local_filesystem(fstype)){free(line);fclose(f);fail(EXIT_SCAN,"UNKNOWN_FILESYSTEM_REJECTED");}mount_spec *match=NULL;for(size_t i=0;i<o->mount_count;i++)if(o->mounts[i].expected.mount_id==mount_id&&!strcmp(o->mounts[i].path,mount_path)){if(match){free(line);fclose(f);fail(EXIT_SCAN,"MOUNT_COVERAGE_DUPLICATE");}match=&o->mounts[i];}if(!match){free(line);fclose(f);fail(EXIT_SCAN,"MOUNT_COVERAGE_OMISSION");}match->covered=1;disposition="SCAN";result.scanned++;}
    sha_u64(&digest,mount_id);sha_u64(&digest,parent_id);sha_text(&digest,mount_root);sha_text(&digest,mount_path);sha_text(&digest,fstype);sha_text(&digest,source);sha_text(&digest,disposition);
  }
  if(ferror(f)){free(line);fclose(f);fail(EXIT_SCAN,"MOUNTINFO_READ_FAILED");}free(line);fclose(f);for(size_t i=0;i<autofs_count;i++){size_t matches=0;for(size_t n=0;n<binfmt_count;n++)if(binfmt_parent_ids[n]==autofs_ids[i])matches++;if(matches==0)fail(EXIT_SCAN,"AUTOFS_PLACEHOLDER_CHILD_MISSING");if(matches!=1)fail(EXIT_SCAN,"AUTOFS_PLACEHOLDER_CHILD_AMBIGUOUS");}for(size_t i=0;i<o->mount_count;i++)if(!o->mounts[i].covered)fail(EXIT_SCAN,"MOUNT_SPEC_NOT_IN_MOUNTINFO");finish_sha(&digest,result.inventory_sha256);return result;
}
static mount_coverage validate_mount_coverage(options *o){return validate_mount_coverage_file(o,"/proc/self/mountinfo");}

static options *active_options;
static mount_spec *active_mount;
static scan_counts *active_counts;
static int scan_error;
static sha256_context active_inventory;

static uint16_t le16(const uint8_t *p){return (uint16_t)p[0]|((uint16_t)p[1]<<8);}
static uint32_t le32(const uint8_t *p){return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24);}
static int same_object_stat(const struct stat *a,const struct stat *b){return a->st_dev==b->st_dev&&a->st_ino==b->st_ino&&a->st_uid==b->st_uid&&a->st_gid==b->st_gid&&a->st_mode==b->st_mode&&a->st_nlink==b->st_nlink&&a->st_ctim.tv_sec==b->st_ctim.tv_sec&&a->st_ctim.tv_nsec==b->st_ctim.tv_nsec;}
static void descriptor_path(int fd,char out[64]){if(snprintf(out,64,"/proc/self/fd/%d",fd)>=64){scan_error=1;out[0]='\0';}}
static ssize_t descriptor_listxattr(int fd,int symlink,char *buffer,size_t size){if(symlink){errno=ENOTSUP;return -1;}ssize_t result=flistxattr(fd,buffer,size);if(result<0&&errno==EBADF){char path[64];descriptor_path(fd,path);if(scan_error)return -1;result=listxattr(path,buffer,size);}return result;}
static ssize_t descriptor_getxattr(int fd,int symlink,const char *name,void *buffer,size_t size){if(symlink){errno=ENOTSUP;return -1;}ssize_t result=fgetxattr(fd,name,buffer,size);if(result<0&&errno==EBADF){char path[64];descriptor_path(fd,path);if(scan_error)return -1;result=getxattr(path,name,buffer,size);}return result;}
static void scan_acl_fd(int fd,int symlink,const char *name,int is_default) {
  ssize_t size=descriptor_getxattr(fd,symlink,name,NULL,0);if(size<0){if(errno==ENODATA||errno==ENOTSUP)return;scan_error=1;return;}if(size<4||(size_t)(size-4)%8U){scan_error=1;return;}
  uint8_t *first=malloc((size_t)size),*second=malloc((size_t)size);if(!first||!second){free(first);free(second);scan_error=1;return;}ssize_t got_first=descriptor_getxattr(fd,symlink,name,first,(size_t)size);ssize_t repeated_size=descriptor_getxattr(fd,symlink,name,NULL,0);ssize_t got_second=repeated_size==size?descriptor_getxattr(fd,symlink,name,second,(size_t)size):-1;if(got_first!=size||repeated_size!=size||got_second!=size||memcmp(first,second,(size_t)size)||le32(first)!=ACL_XATTR_VERSION){free(first);free(second);scan_error=1;return;}
  sha_text(&active_inventory,name);sha_bytes(&active_inventory,first,(size_t)size);
  for(ssize_t off=4;off<size;off+=8){uint16_t tag=le16(first+off);uint32_t id=le32(first+off+4);if(!(tag==0x01U||tag==ACL_USER||tag==0x04U||tag==ACL_GROUP||tag==0x10U||tag==0x20U)){free(first);free(second);scan_error=1;return;}if(tag==ACL_USER&&id==active_options->candidate_uid){if(is_default)active_counts->default_user_acl++;else active_counts->access_user_acl++;}if(tag==ACL_GROUP&&id==active_options->candidate_gid){if(is_default)active_counts->default_group_acl++;else active_counts->access_group_acl++;}}
  free(first);free(second);
}
static int compare_names(const void *a,const void *b){return strcmp(*(char*const*)a,*(char*const*)b);}
static void scan_descriptor(int fd,const char *path){
  struct stat before,after;if(fstat(fd,&before)){scan_error=1;return;}struct statx sx;memset(&sx,0,sizeof(sx));if(statx(fd,"",AT_EMPTY_PATH|AT_SYMLINK_NOFOLLOW,STATX_MNT_ID,&sx)||(sx.stx_mask&STATX_MNT_ID)==0){scan_error=1;return;}if((uint64_t)sx.stx_mnt_id!=active_mount->expected.mount_id)return;int symlink=S_ISLNK(before.st_mode);
  active_counts->objects++;if((uint64_t)before.st_uid==active_options->candidate_uid)active_counts->uid_owned++;if((uint64_t)before.st_gid==active_options->candidate_gid)active_counts->gid_owned++;
  sha_text(&active_inventory,path);sha_u64(&active_inventory,(uint64_t)before.st_dev);sha_u64(&active_inventory,(uint64_t)before.st_ino);sha_u64(&active_inventory,(uint64_t)before.st_uid);sha_u64(&active_inventory,(uint64_t)before.st_gid);sha_u64(&active_inventory,(uint64_t)before.st_mode);sha_u64(&active_inventory,(uint64_t)before.st_nlink);sha_u64(&active_inventory,(uint64_t)before.st_ctim.tv_sec);sha_u64(&active_inventory,(uint64_t)before.st_ctim.tv_nsec);
  ssize_t names_size=descriptor_listxattr(fd,symlink,NULL,0);if(names_size<0&&errno==ENOTSUP)names_size=0;if(names_size<0){scan_error=1;return;}if(names_size){char *first=malloc((size_t)names_size),*second=malloc((size_t)names_size);if(!first||!second){free(first);free(second);scan_error=1;return;}ssize_t got_first=descriptor_listxattr(fd,symlink,first,(size_t)names_size);ssize_t repeated_size=descriptor_listxattr(fd,symlink,NULL,0);ssize_t got_second=repeated_size==names_size?descriptor_listxattr(fd,symlink,second,(size_t)names_size):-1;if(got_first!=names_size||repeated_size!=names_size||got_second!=names_size||memcmp(first,second,(size_t)names_size)){free(first);free(second);scan_error=1;return;}for(ssize_t off=0;off<got_first;){size_t remaining=(size_t)(got_first-off);size_t len=strnlen(first+off,remaining);if(len==remaining){free(first);free(second);scan_error=1;return;}const char *name=first+off;if(!strcmp(name,"system.posix_acl_access"))scan_acl_fd(fd,symlink,name,0);else if(!strcmp(name,"system.posix_acl_default"))scan_acl_fd(fd,symlink,name,1);if(scan_error){free(first);free(second);return;}off+=(ssize_t)len+1;}free(first);free(second);}else if(symlink)sha_text(&active_inventory,"SYMLINK_NO_POSIX_ACL");
  if(S_ISDIR(before.st_mode)){int duplicate=dup(fd);if(duplicate<0){scan_error=1;return;}DIR *directory=fdopendir(duplicate);if(!directory){close(duplicate);scan_error=1;return;}char **names=NULL;size_t count=0;for(;;){errno=0;struct dirent *entry=readdir(directory);if(!entry){if(errno)scan_error=1;break;}if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;char *copy=strdup(entry->d_name);char **grown=copy?realloc(names,(count+1)*sizeof(*names)):NULL;if(!copy||!grown){free(copy);scan_error=1;break;}names=grown;names[count++]=copy;}closedir(directory);if(scan_error){for(size_t i=0;i<count;i++)free(names[i]);free(names);return;}qsort(names,count,sizeof(*names),compare_names);for(size_t i=0;i<count;i++){char child_path[PATH_MAX];int length=!strcmp(path,"/")?snprintf(child_path,sizeof(child_path),"/%s",names[i]):snprintf(child_path,sizeof(child_path),"%s/%s",path,names[i]);if(length<0||length>=(int)sizeof(child_path)){scan_error=1;}else{int child=openat(fd,names[i],O_PATH|O_NOFOLLOW|O_CLOEXEC);if(child<0)scan_error=1;else{struct stat child_stat;if(fstat(child,&child_stat))scan_error=1;else if(S_ISDIR(child_stat.st_mode)){int child_directory=openat(fd,names[i],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(child_directory<0)scan_error=1;else{struct stat opened;if(fstat(child_directory,&opened)||!same_object_stat(&child_stat,&opened))scan_error=1;else scan_descriptor(child_directory,child_path);close(child_directory);}}else scan_descriptor(child,child_path);close(child);}}free(names[i]);if(scan_error){for(size_t j=i+1;j<count;j++)free(names[j]);break;}}free(names);}
  struct statx sx_after;memset(&sx_after,0,sizeof(sx_after));if(fstat(fd,&after)||statx(fd,"",AT_EMPTY_PATH|AT_SYMLINK_NOFOLLOW,STATX_MNT_ID,&sx_after)||(sx_after.stx_mask&STATX_MNT_ID)==0||!same_object_stat(&before,&after)||sx.stx_mnt_id!=sx_after.stx_mnt_id)scan_error=1;
}
static scan_counts scan_mount(mount_spec *m) {
  int fd=open(m->path,O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);if(fd<0)fail(EXIT_SCAN,"MOUNT_OPEN_FAILED");snapshot observed=inspect_fd(fd,0);
  if(!strcmp(active_options->environment,"rehearsal")&&m->expected.device==0&&m->expected.inode==0&&m->expected.mount_id==0&&m->expected.mount_flags==0&&m->expected.fs_magic==0&&m->expected.uid==0&&m->expected.gid==0&&m->expected.mode==0)m->expected=observed;
  if(observed.device!=m->expected.device||observed.inode!=m->expected.inode||observed.mount_id!=m->expected.mount_id||observed.mount_flags!=m->expected.mount_flags||observed.fs_magic!=m->expected.fs_magic||observed.uid!=m->expected.uid||observed.gid!=m->expected.gid||observed.mode!=m->expected.mode){close(fd);fail(EXIT_SCAN,"MOUNT_PREIMAGE_MISMATCH");}
  scan_counts counts;memset(&counts,0,sizeof(counts));active_mount=m;active_counts=&counts;scan_error=0;sha_init(&active_inventory);sha_text(&active_inventory,m->path);scan_descriptor(fd,m->path);close(fd);if(scan_error)fail(EXIT_SCAN,"MOUNT_SCAN_INCOMPLETE");finish_sha(&active_inventory,counts.inventory_sha256);return counts;
}
static void add_counts(scan_counts *a,const scan_counts *b){a->objects+=b->objects;a->uid_owned+=b->uid_owned;a->gid_owned+=b->gid_owned;a->access_user_acl+=b->access_user_acl;a->access_group_acl+=b->access_group_acl;a->default_user_acl+=b->default_user_acl;a->default_group_acl+=b->default_group_acl;}
static int equal_counts(const scan_counts *a,const scan_counts *b){return a->objects==b->objects&&a->uid_owned==b->uid_owned&&a->gid_owned==b->gid_owned&&a->access_user_acl==b->access_user_acl&&a->access_group_acl==b->access_group_acl&&a->default_user_acl==b->default_user_acl&&a->default_group_acl==b->default_group_acl&&!strcmp(a->inventory_sha256,b->inventory_sha256);}

typedef struct {uint64_t uid[4];uint64_t gid[4];uint64_t *groups;size_t group_count;} process_credentials;
static void free_credentials(process_credentials *c){free(c->groups);memset(c,0,sizeof(*c));}
static process_credentials read_credentials(const char *path){process_credentials c={0};FILE *f=fopen(path,"re");if(!f)fail(EXIT_SCAN,"PROC_STATUS_OPEN_FAILED");char *line=NULL;size_t cap=0;int saw_uid=0,saw_gid=0,saw_groups=0;while(getline(&line,&cap,f)>=0){char extra;if(!strncmp(line,"Uid:",4)){if(sscanf(line,"Uid: %"SCNu64" %"SCNu64" %"SCNu64" %"SCNu64" %c",&c.uid[0],&c.uid[1],&c.uid[2],&c.uid[3],&extra)!=4){free(line);fclose(f);free_credentials(&c);fail(EXIT_SCAN,"PROC_UID_MALFORMED");}saw_uid=1;}else if(!strncmp(line,"Gid:",4)){if(sscanf(line,"Gid: %"SCNu64" %"SCNu64" %"SCNu64" %"SCNu64" %c",&c.gid[0],&c.gid[1],&c.gid[2],&c.gid[3],&extra)!=4){free(line);fclose(f);free_credentials(&c);fail(EXIT_SCAN,"PROC_GID_MALFORMED");}saw_gid=1;}else if(!strncmp(line,"Groups:",7)){char *save=NULL;for(char *token=strtok_r(line+7," \t\r\n",&save);token;token=strtok_r(NULL," \t\r\n",&save)){uint64_t value=runtime_u64(token,"PROC_GROUP_INVALID");uint64_t *grown=realloc(c.groups,(c.group_count+1)*sizeof(*c.groups));if(!grown){free(line);fclose(f);free_credentials(&c);fail(EXIT_SCAN,"PROC_GROUP_MEMORY_FAILED");}c.groups=grown;c.groups[c.group_count++]=value;}saw_groups=1;}}
  int failed=ferror(f)||fclose(f)||!saw_uid||!saw_gid||!saw_groups;free(line);if(failed){free_credentials(&c);fail(EXIT_SCAN,"PROC_STATUS_READ_FAILED");}return c;}
static int equal_credentials(const process_credentials *a,const process_credentials *b){return !memcmp(a->uid,b->uid,sizeof(a->uid))&&!memcmp(a->gid,b->gid,sizeof(a->gid))&&a->group_count==b->group_count&&(!a->group_count||!memcmp(a->groups,b->groups,a->group_count*sizeof(*a->groups)));}
static uint64_t process_starttime(long pid){char path[64];snprintf(path,sizeof(path),"/proc/%ld/stat",pid);FILE *f=fopen(path,"re");if(!f)fail(EXIT_SCAN,"PROC_STAT_OPEN_FAILED");char *line=NULL;size_t cap=0;if(getline(&line,&cap,f)<0||ferror(f)||fclose(f)){free(line);fail(EXIT_SCAN,"PROC_STAT_READ_FAILED");}char *right=strrchr(line,')');if(!right||right[1]!=' '){free(line);fail(EXIT_SCAN,"PROC_STAT_MALFORMED");}size_t field=3;uint64_t start=0;char *save=NULL;for(char *token=strtok_r(right+2," \t\r\n",&save);token;token=strtok_r(NULL," \t\r\n",&save),field++)if(field==22){start=runtime_u64(token,"PROC_STARTTIME_INVALID");break;}free(line);if(!start)fail(EXIT_SCAN,"PROC_STARTTIME_MISSING");return start;}
static int compare_long(const void *a,const void *b){long x=*(const long*)a,y=*(const long*)b;return (x>y)-(x<y);}
static process_counts scan_processes(void) {
  process_counts c={0};DIR *d=opendir("/proc");if(!d)fail(EXIT_SCAN,"PROC_OPEN_FAILED");long *pids=NULL;size_t count=0;
  for(;;){errno=0;struct dirent *e=readdir(d);if(!e){if(errno){closedir(d);free(pids);fail(EXIT_SCAN,"PROC_READ_FAILED");}break;}char *end=NULL;errno=0;long pid=strtol(e->d_name,&end,10);if(errno||end==e->d_name||*end||pid<=0)continue;long *grown=realloc(pids,(count+1)*sizeof(*pids));if(!grown){closedir(d);free(pids);fail(EXIT_SCAN,"PROC_MEMORY_FAILED");}pids=grown;pids[count++]=pid;}closedir(d);qsort(pids,count,sizeof(*pids),compare_long);sha256_context inventory;sha_init(&inventory);
  for(size_t n=0;n<count;n++){long pid=pids[n];uint64_t start_before=process_starttime(pid);char path[64];snprintf(path,sizeof(path),"/proc/%ld/status",pid);process_credentials first=read_credentials(path),second=read_credentials(path);uint64_t start_after=process_starttime(pid);if(start_before!=start_after||!equal_credentials(&first,&second)){free_credentials(&first);free_credentials(&second);free(pids);fail(EXIT_SCAN,"PROC_CREDENTIAL_DRIFT");}c.processes++;for(size_t i=0;i<4;i++){if(first.uid[i]==active_options->candidate_uid){c.uid_matches++;break;}}for(size_t i=0;i<4;i++){if(first.gid[i]==active_options->candidate_gid){c.gid_matches++;break;}}for(size_t i=0;i<first.group_count;i++){if(first.groups[i]==active_options->candidate_gid){c.supplementary_gid_matches++;break;}}sha_u64(&inventory,(uint64_t)pid);sha_u64(&inventory,start_before);for(size_t i=0;i<4;i++)sha_u64(&inventory,first.uid[i]);for(size_t i=0;i<4;i++)sha_u64(&inventory,first.gid[i]);sha_u64(&inventory,(uint64_t)first.group_count);for(size_t i=0;i<first.group_count;i++)sha_u64(&inventory,first.groups[i]);free_credentials(&first);free_credentials(&second);}
  free(pids);finish_sha(&inventory,c.inventory_sha256);return c;
}
static ipc_counts scan_ipc_file(const char *path) {
  ipc_counts c={0};FILE *f=fopen(path,"re");if(!f)fail(EXIT_SCAN,"IPC_OPEN_FAILED");char *line=NULL;size_t cap=0;if(getline(&line,&cap,f)<0){free(line);fclose(f);fail(EXIT_SCAN,"IPC_HEADER_FAILED");}
  char *names[64];size_t columns=0;char *save=NULL;for(char *t=strtok_r(line," \t\r\n",&save);t;t=strtok_r(NULL," \t\r\n",&save)){if(columns>=64){for(size_t i=0;i<columns;i++)free(names[i]);free(line);fclose(f);fail(EXIT_SCAN,"IPC_TOO_MANY_COLUMNS");}names[columns]=strdup(t);if(!names[columns]){for(size_t i=0;i<columns;i++)free(names[i]);free(line);fclose(f);fail(EXIT_SCAN,"IPC_HEADER_MEMORY_FAILED");}columns++;}
  int key_index=-1,id_index=-1,uid_index=-1,gid_index=-1,cuid_index=-1,cgid_index=-1;for(size_t i=0;i<columns;i++){if(!strcmp(names[i],"key"))key_index=(int)i;else if(!strcmp(names[i],"msqid")||!strcmp(names[i],"semid")||!strcmp(names[i],"shmid"))id_index=(int)i;else if(!strcmp(names[i],"uid"))uid_index=(int)i;else if(!strcmp(names[i],"gid"))gid_index=(int)i;else if(!strcmp(names[i],"cuid"))cuid_index=(int)i;else if(!strcmp(names[i],"cgid"))cgid_index=(int)i;}if(key_index<0||id_index<0||uid_index<0||gid_index<0||cuid_index<0||cgid_index<0){for(size_t i=0;i<columns;i++)free(names[i]);free(line);fclose(f);fail(EXIT_SCAN,"IPC_REQUIRED_COLUMNS_MISSING");}
  sha256_context inventory;sha_init(&inventory);sha_text(&inventory,path);while(getline(&line,&cap,f)>=0){char *values[64];size_t n=0;save=NULL;for(char *t=strtok_r(line," \t\r\n",&save);t;t=strtok_r(NULL," \t\r\n",&save)){if(n>=64){for(size_t i=0;i<columns;i++)free(names[i]);free(line);fclose(f);fail(EXIT_SCAN,"IPC_TOO_MANY_COLUMNS");}values[n++]=t;}if(n!=columns){for(size_t i=0;i<columns;i++)free(names[i]);free(line);fclose(f);fail(EXIT_SCAN,"IPC_ROW_MALFORMED");}c.rows++;int selected[]={key_index,id_index,uid_index,gid_index,cuid_index,cgid_index};for(size_t i=0;i<sizeof(selected)/sizeof(selected[0]);i++){uint64_t value=runtime_u64(values[selected[i]],"IPC_VALUE_INVALID");sha_u64(&inventory,value);if((selected[i]==uid_index||selected[i]==cuid_index)&&value==active_options->candidate_uid)c.uid_matches++;if((selected[i]==gid_index||selected[i]==cgid_index)&&value==active_options->candidate_gid)c.gid_matches++;}}
  if(ferror(f)){for(size_t i=0;i<columns;i++)free(names[i]);free(line);fclose(f);fail(EXIT_SCAN,"IPC_READ_FAILED");}for(size_t i=0;i<columns;i++)free(names[i]);free(line);fclose(f);finish_sha(&inventory,c.inventory_sha256);return c;
}
static ipc_counts scan_all_ipc(void){const char *paths[]={"/proc/sysvipc/msg","/proc/sysvipc/sem","/proc/sysvipc/shm"};ipc_counts total={0};sha256_context inventory;sha_init(&inventory);for(size_t i=0;i<sizeof(paths)/sizeof(paths[0]);i++){ipc_counts current=scan_ipc_file(paths[i]);total.rows+=current.rows;total.uid_matches+=current.uid_matches;total.gid_matches+=current.gid_matches;sha_text(&inventory,paths[i]);sha_text(&inventory,current.inventory_sha256);}finish_sha(&inventory,total.inventory_sha256);return total;}

static int reserve_file(int cwd,const char *name,const snapshot *custody) { int fd=openat(cwd,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);if(fd<0)fail(EXIT_EVIDENCE,"EVIDENCE_RESERVATION_FAILED");snapshot s=inspect_fd(fd,1);if(s.uid||s.gid||s.mode!=0600U||s.links!=1||s.device!=custody->device||s.mount_id!=custody->mount_id||s.mount_flags!=custody->mount_flags||s.fs_magic!=custody->fs_magic){close(fd);fail(EXIT_EVIDENCE,"EVIDENCE_CUSTODY_REJECTED");}return fd; }
static void write_exact(int fd,const char *data,size_t n) { size_t off=0;while(off<n){ssize_t w=write(fd,data+off,n-off);if(w<0){if(errno==EINTR)continue;fail(EXIT_EVIDENCE,"EVIDENCE_WRITE_FAILED");}off+=(size_t)w;}if(fsync(fd))fail(EXIT_EVIDENCE,"EVIDENCE_FSYNC_FAILED"); }
static int blocked(const scan_counts *s,const process_counts *p,const ipc_counts *i){return s->uid_owned||s->gid_owned||s->access_user_acl||s->access_group_acl||s->default_user_acl||s->default_group_acl||p->uid_matches||p->gid_matches||p->supplementary_gid_matches||i->uid_matches||i->gid_matches;}
static void read_boot_id(char out[37]){FILE *f=fopen("/proc/sys/kernel/random/boot_id","re");if(!f)fail(EXIT_PRECONDITION,"BOOT_ID_OPEN_FAILED");char line[64];if(!fgets(line,sizeof(line),f)||ferror(f)||fclose(f))fail(EXIT_PRECONDITION,"BOOT_ID_READ_FAILED");line[strcspn(line,"\r\n")]='\0';if(!uuid36(line))fail(EXIT_PRECONDITION,"BOOT_ID_MALFORMED");strcpy(out,line);}
static void read_hostname(char out[256]){memset(out,0,256);if(gethostname(out,255)||!safe_name(out))fail(EXIT_PRECONDITION,"HOSTNAME_READ_FAILED");}
static struct timespec checked_now(const options *o){struct timespec now;if(clock_gettime(CLOCK_REALTIME,&now)||now.tv_sec<0)fail(EXIT_PRECONDITION,"CLOCK_READ_FAILED");uint64_t seconds=(uint64_t)now.tv_sec;if(seconds<o->issued_at_unix||seconds>o->expires_at_unix)fail(EXIT_PRECONDITION,"FRESHNESS_WINDOW_REJECTED");return now;}

int main(int argc,char **argv) {
  umask(077);options o=parse_options(argc,argv);active_options=&o;if(getuid()||geteuid()||getgid()||getegid())fail(EXIT_PRECONDITION,"ROOT_IDENTITY_REQUIRED");
  if(signal(SIGPIPE,SIG_IGN)==SIG_ERR||prctl(PR_SET_DUMPABLE,0)||prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0))fail(EXIT_PRECONDITION,"PROCESS_HARDENING_FAILED");
  if(clearenv()||setenv("LC_ALL","C",1))fail(EXIT_PRECONDITION,"ENVIRONMENT_RESET_FAILED");
  alarm(o.deadline_seconds);struct timespec started=checked_now(&o);char hostname[256],boot_id[37];read_hostname(hostname);read_boot_id(boot_id);if(strcmp(hostname,o.expected_hostname)||strcmp(boot_id,o.expected_boot_id))fail(EXIT_PRECONDITION,"HOST_BINDING_MISMATCH");
  int self=open("/proc/self/exe",O_RDONLY|O_CLOEXEC);if(self<0)fail(EXIT_CUSTODY,"SELF_OPEN_FAILED");snapshot self_s=inspect_fd(self,1);if(self_s.uid||self_s.gid||self_s.mode!=0500U||self_s.links!=1)fail(EXIT_CUSTODY,"SELF_CUSTODY_REJECTED");char self_sha[65];digest_fd(self,self_sha);close(self);if(strcmp(self_sha,o.expected_self_sha256))fail(EXIT_CUSTODY,"SELF_DIGEST_MISMATCH");
  int cwd=open(".",O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);if(cwd<0)fail(EXIT_CUSTODY,"CWD_OPEN_FAILED");snapshot custody=inspect_fd(cwd,1);int rehearsal_unpinned=!strcmp(o.environment,"rehearsal")&&o.expected_cwd.device==0&&o.expected_cwd.inode==0&&o.expected_cwd.mount_id==0&&o.expected_cwd.mount_flags==0;if(custody.uid||custody.gid||custody.mode!=0700U||(!rehearsal_unpinned&&(custody.device!=o.expected_cwd.device||custody.inode!=o.expected_cwd.inode||custody.mount_id!=o.expected_cwd.mount_id||custody.mount_flags!=o.expected_cwd.mount_flags)))fail(EXIT_CUSTODY,"CWD_CUSTODY_REJECTED");
  char mount_before[65];digest_path("/proc/self/mountinfo",mount_before);if(strcmp(mount_before,o.expected_mountinfo_sha256))fail(EXIT_PRECONDITION,"MOUNTINFO_PREIMAGE_MISMATCH");mount_coverage coverage=validate_mount_coverage(&o);char mount_validated[65];digest_path("/proc/self/mountinfo",mount_validated);if(strcmp(mount_before,mount_validated))fail(EXIT_SCAN,"MOUNTINFO_VALIDATION_DRIFT");
  int evidence=reserve_file(cwd,o.evidence_name,&custody);
  scan_counts first={0},second={0},first_mounts[MAX_MOUNTS],second_mounts[MAX_MOUNTS];for(size_t i=0;i<o.mount_count;i++){first_mounts[i]=scan_mount(&o.mounts[i]);add_counts(&first,&first_mounts[i]);}process_counts p1=scan_processes();ipc_counts i1=scan_all_ipc();
  for(size_t i=0;i<o.mount_count;i++){second_mounts[i]=scan_mount(&o.mounts[i]);add_counts(&second,&second_mounts[i]);}process_counts p2=scan_processes();ipc_counts i2=scan_all_ipc();
  for(size_t i=0;i<o.mount_count;i++)if(!equal_counts(&first_mounts[i],&second_mounts[i]))fail(EXIT_SCAN,"CONVERGENCE_FAILED");
  if(!equal_counts(&first,&second)||p1.processes!=p2.processes||p1.uid_matches!=p2.uid_matches||p1.gid_matches!=p2.gid_matches||p1.supplementary_gid_matches!=p2.supplementary_gid_matches||strcmp(p1.inventory_sha256,p2.inventory_sha256)||i1.rows!=i2.rows||i1.uid_matches!=i2.uid_matches||i1.gid_matches!=i2.gid_matches||strcmp(i1.inventory_sha256,i2.inventory_sha256))fail(EXIT_SCAN,"CONVERGENCE_FAILED");
  char mount_after[65];digest_path("/proc/self/mountinfo",mount_after);if(strcmp(mount_before,mount_after))fail(EXIT_SCAN,"MOUNTINFO_DRIFT");
  snapshot custody_after=inspect_fd(cwd,1);if(!same_snapshot(&custody,&custody_after))fail(EXIT_CUSTODY,"CWD_CUSTODY_DRIFT");
  struct timespec completed=checked_now(&o);read_hostname(hostname);read_boot_id(boot_id);if(strcmp(hostname,o.expected_hostname)||strcmp(boot_id,o.expected_boot_id))fail(EXIT_PRECONDITION,"HOST_BINDING_DRIFT");int is_blocked=blocked(&second,&p2,&i2);char *json=NULL;size_t json_size=0;FILE *stream=open_memstream(&json,&json_size);if(!stream)fail(EXIT_EVIDENCE,"SUMMARY_STREAM_FAILED");
  fprintf(stream,"{\"schemaVersion\":1,\"artifactKind\":\"legacy-game-command-h2-identity-audit\",\"environment\":\"%s\",\"attemptId\":\"%s\",\"leaseSha256\":\"%s\",\"hostname\":\"%s\",\"bootId\":\"%s\",\"evidenceName\":\"%s\",\"issuedAtUnix\":%"PRIu64",\"expiresAtUnix\":%"PRIu64",\"startedUnixSeconds\":%"PRIu64",\"startedUnixNanos\":%ld,\"completedUnixSeconds\":%"PRIu64",\"completedUnixNanos\":%ld,\"deadlineSeconds\":%u,\"candidateUid\":%"PRIu64",\"candidateGid\":%"PRIu64",\"selfSha256\":\"%s\",\"mountinfoSha256\":\"%s\",\"mountCoverage\":{\"scanned\":%"PRIu64",\"excludedKernelPseudo\":%"PRIu64",\"inventorySha256\":\"%s\"},\"mounts\":[",o.environment,o.attempt_id,o.lease_sha256,hostname,boot_id,o.evidence_name,o.issued_at_unix,o.expires_at_unix,(uint64_t)started.tv_sec,started.tv_nsec,(uint64_t)completed.tv_sec,completed.tv_nsec,o.deadline_seconds,o.candidate_uid,o.candidate_gid,self_sha,mount_after,coverage.scanned,coverage.excluded,coverage.inventory_sha256);
  for(size_t i=0;i<o.mount_count;i++){if(i)fputc(',',stream);fprintf(stream,"{\"path\":\"%s\",\"device\":\"%"PRIu64"\",\"inode\":\"%"PRIu64"\",\"mountId\":\"%"PRIu64"\",\"mountFlags\":\"%"PRIu64"\",\"fsMagic\":\"0x%"PRIx64"\",\"firstObjects\":%"PRIu64",\"secondObjects\":%"PRIu64",\"firstInventorySha256\":\"%s\",\"secondInventorySha256\":\"%s\"}",o.mounts[i].path,o.mounts[i].expected.device,o.mounts[i].expected.inode,o.mounts[i].expected.mount_id,o.mounts[i].expected.mount_flags,o.mounts[i].expected.fs_magic,first_mounts[i].objects,second_mounts[i].objects,first_mounts[i].inventory_sha256,second_mounts[i].inventory_sha256);}
  fprintf(stream,"],\"firstObjects\":%"PRIu64",\"objects\":%"PRIu64",\"uidOwned\":%"PRIu64",\"gidOwned\":%"PRIu64",\"accessUserAcl\":%"PRIu64",\"accessGroupAcl\":%"PRIu64",\"defaultUserAcl\":%"PRIu64",\"defaultGroupAcl\":%"PRIu64",\"processes\":%"PRIu64",\"processUidMatches\":%"PRIu64",\"processGidMatches\":%"PRIu64",\"processSupplementaryGidMatches\":%"PRIu64",\"processFirstInventorySha256\":\"%s\",\"processSecondInventorySha256\":\"%s\",\"ipcRows\":%"PRIu64",\"ipcUidMatches\":%"PRIu64",\"ipcGidMatches\":%"PRIu64",\"ipcFirstInventorySha256\":\"%s\",\"ipcSecondInventorySha256\":\"%s\",\"status\":\"%s\",\"mutationPerformed\":false,\"creationAuthorized\":false,\"postcheckComplete\":true}\n",first.objects,second.objects,second.uid_owned,second.gid_owned,second.access_user_acl,second.access_group_acl,second.default_user_acl,second.default_group_acl,p2.processes,p2.uid_matches,p2.gid_matches,p2.supplementary_gid_matches,p1.inventory_sha256,p2.inventory_sha256,i2.rows,i2.uid_matches,i2.gid_matches,i1.inventory_sha256,i2.inventory_sha256,is_blocked?"BLOCKED":"GO");
  if(fclose(stream)||!json)fail(EXIT_EVIDENCE,"SUMMARY_BUILD_FAILED");
  write_exact(evidence,json,json_size);close(evidence);
  sha256_context hc;sha_init(&hc);sha_update(&hc,(const uint8_t*)json,json_size);uint8_t hd[32];sha_final(&hc,hd);char evidence_sha[65];hex_digest(hd,evidence_sha);
  struct timespec marker_time=checked_now(&o);char marker_hostname[256],marker_boot_id[37];read_hostname(marker_hostname);read_boot_id(marker_boot_id);if(strcmp(marker_hostname,hostname)||strcmp(marker_boot_id,boot_id))fail(EXIT_PRECONDITION,"HOST_BINDING_DRIFT");char marker_name[NAME_MAX];if(snprintf(marker_name,sizeof(marker_name),"%s.complete",o.evidence_name)>=(int)sizeof(marker_name))fail(EXIT_EVIDENCE,"MARKER_NAME_TOO_LONG");int marker=reserve_file(cwd,marker_name,&custody);char marker_json[1024];int marker_size=snprintf(marker_json,sizeof(marker_json),"{\"schemaVersion\":1,\"attemptId\":\"%s\",\"leaseSha256\":\"%s\",\"hostname\":\"%s\",\"bootId\":\"%s\",\"evidenceName\":\"%s\",\"evidenceSha256\":\"%s\",\"markerUnixSeconds\":%"PRIu64",\"markerUnixNanos\":%ld,\"status\":\"%s\",\"creationAuthorized\":false}\n",o.attempt_id,o.lease_sha256,hostname,boot_id,o.evidence_name,evidence_sha,(uint64_t)marker_time.tv_sec,marker_time.tv_nsec,is_blocked?"BLOCKED":"GO");if(marker_size<0||marker_size>=(int)sizeof(marker_json))fail(EXIT_EVIDENCE,"MARKER_BUILD_FAILED");write_exact(marker,marker_json,(size_t)marker_size);close(marker);if(fsync(cwd))fail(EXIT_EVIDENCE,"CWD_FSYNC_FAILED");snapshot final_custody=inspect_fd(cwd,1);if(!same_snapshot(&custody,&final_custody))fail(EXIT_CUSTODY,"CWD_CUSTODY_DRIFT");
  if(fwrite(json,1,json_size,stdout)!=json_size||fflush(stdout)){free(json);fail(EXIT_EVIDENCE,"STDOUT_WRITE_FAILED");}free(json);close(cwd);return is_blocked?2:0;
}
