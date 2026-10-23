export type PlatformCapability = { readonly feature: string; readonly supported: boolean; readonly reason: string };
/** Pure D-platform preflight; never an execution grant or a substitute UID. */
export function supportsManagedContext(platform: string, uid: number | undefined): boolean {
  return ["linux", "darwin"].includes(platform) && Number.isSafeInteger(uid) && uid !== undefined && uid > 0;
}
/** Pure support metadata, not a relaxation of any OS security or execution gate. */
export function platformCapabilities(platform: string): readonly PlatformCapability[] {
  const basic = ["linux", "darwin", "win32"].includes(platform), posix = ["linux", "darwin"].includes(platform);
  return [
    { feature: "routing/decision/ordinary delegate/verification/native approval", supported: basic,
      reason: basic ? "Basic path supported; account/model/task success requires separate validation" : "Unsupported OS" },
    { feature: "Goal/sequence/private memory/managed context/SoL-Pi", supported: posix,
      reason: posix ? "POSIX security boundary implemented; advanced live-use/v1 evidence incomplete" : platform === "win32" ? "Bounded Goal SID/DACL, project-lock and Job/SDK paths ported; full sequence/SoL-Pi/D/v1 validation incomplete; import success is not execution support" : "Unsupported OS; import success is not execution support" },
    { feature: "C2 isolated verifier", supported: platform === "linux",
      reason: platform === "linux" ? "Requires an approved local Engine/image/cgroup/seccomp/Yama contract; no automatic preparation" : "Linux-container contract only; no automatic host-check or named-pipe replacement" },
  ];
}
