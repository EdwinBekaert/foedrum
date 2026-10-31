// When the check sandbox's integration test may send a name query (#702, #720, ADR 0277): only
// through systemd-resolved's stub, on CI as off it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { linuxResolverUnavailable, resolverLeavesMachine } from '../helpers/resolver.ts';

const stub = 'nameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n';
const secondNameserver = 'nameserver 127.0.0.53\nnameserver 168.63.129.16\n';

const onCi = (resolvConf: string | undefined) =>
  linuxResolverUnavailable({ platform: 'linux', inCi: true, slirp4netns: true, resolvConf });

describe('resolverLeavesMachine', () => {
  it('accepts a resolv.conf naming only 127.0.0.53', () => {
    assert.equal(resolverLeavesMachine(stub), undefined);
  });

  it('refuses a resolv.conf with a second nameserver', () => {
    assert.equal(
      resolverLeavesMachine(secondNameserver),
      "the host's resolver is not systemd-resolved's stub alone",
    );
  });
});

describe('linuxResolverUnavailable', () => {
  it('still runs the resolver test on CI when resolv.conf names only the stub', () => {
    assert.equal(onCi(stub), undefined);
  });

  it('skips the resolver test on CI when resolv.conf names a second nameserver', () => {
    assert.equal(
      onCi(secondNameserver),
      "the host's resolver is not systemd-resolved's stub alone",
    );
  });

  it('skips the resolver test on CI when resolv.conf cannot be read', () => {
    assert.equal(onCi(undefined), '/etc/resolv.conf cannot be read');
  });
});
