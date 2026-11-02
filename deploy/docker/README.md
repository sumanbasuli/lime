# Chromium container policy

`chromium-seccomp.json` is for Docker Engine on Linux amd64 and arm64. It derives
from [Moby's default profile at commit 4b8214fc4971e06172938a1f1554ccff6647ee80](https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json).
The upstream Apache 2.0 license is included in `LICENSE.moby`.

LIME retains all upstream architecture and capability conditions, including the
`clone3` ENOSYS fallback. Five additions, limited to amd64/arm64, allow Chromium's
user-namespace sandbox: `unshare(CLONE_NEWUSER)`, three filtered `clone` namespace
combinations, and `chroot`. The latter does not grant `CAP_SYS_CHROOT`; kernel
permission checks still apply, and Chromium uses it inside its user namespace.
Shopkeeper drops all process capabilities and sets no-new-privileges before
launching the backend or any supplied command.

The source, release, and docs Compose files load this policy from the client
checkout or release bundle. Plain Docker commands need the same policy file on
the Docker client host. Do not pass this Docker-format profile to another OCI
runtime without verifying its condition parser: the tested nerdctl 2.3.5 parser
ignored upstream `includes`/`excludes` conditions and made privileged allows
unconditional.

When updating the upstream profile, retain its license, review every change,
and verify the effective OCI rules plus real PNG/PDF and LIME scan/report paths
on both supported architectures. Do not replace the policy with unconfined mode
or add `CAP_SYS_ADMIN` to make Chromium start.
