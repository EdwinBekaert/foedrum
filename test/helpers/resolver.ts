// Whether the check sandbox's integration test may send a name query through a setup's network
// stack (#702, ADR 0277), decided on text, so a unit test needs no /etc/resolv.conf.

/**
 * Why a name query from a setup could leave this machine, or undefined when it cannot: only
 * systemd-resolved's stub answers localhost itself. `resolvConf` is undefined when the file
 * cannot be read.
 */
export const resolverLeavesMachine = (resolvConf: string | undefined): string | undefined => {
  if (resolvConf === undefined) return '/etc/resolv.conf cannot be read';
  const servers = resolvConf.match(/^nameserver\s+\S+/gm) ?? [];
  return servers.length > 0 && servers.every((server) => server.endsWith('127.0.0.53'))
    ? undefined
    : "the host's resolver is not systemd-resolved's stub alone";
};

/** What the machine has, as the integration test reads it. */
export type ResolverHost = {
  platform: NodeJS.Platform;
  inCi: boolean;
  slirp4netns: boolean;
  resolvConf: string | undefined;
};

/**
 * A host whose query could leave it skips, on CI too, since ubuntu runners differ in their
 * resolver (#720). Off CI so does a host whose stack is pasta, which has no resolver to forward
 * to behind systemd-resolved's stub (ADR 0218); CI's Linux leg must have slirp4netns.
 */
export const linuxResolverUnavailable = (host: ResolverHost): string | undefined => {
  if (host.platform !== 'linux') return 'the stack is a Linux one';
  if (!host.inCi && !host.slirp4netns) {
    return "the stack here is pasta, whose resolver misses systemd-resolved's stub (ADR 0218)";
  }
  return resolverLeavesMachine(host.resolvConf);
};
