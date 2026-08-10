# Authentication, Key Rotation, Credential Loss, and Android Signing Runbook

## Capability ownership

- Operational PC key: request/status/consume only.
- Membership administrator key: pairing, peer revoke, reset, and household deletion only after a local administrator session.
- Accounting key/anchor: protected journal and monotonic debit evidence only.
- Parent device key: parent responses, allowance changes, peer operations, and token registration for its current membership epoch.
- Android release key and update-manifest key are distinct. Custody belongs to the release security owner; production material never enters the repository.

No operational key may invoke membership or accounting operations. Electron must use the authenticated privileged broker and never receive exportable private material.

## Routine rotation

1. Disable `create` and `respond_or_issue`; preserve `consume` only while receipt reconciliation remains healthy.
2. Create the replacement non-exportable key in its protected platform store.
3. Register the replacement public identity under a versioned credential record and retain the old verifier during the bounded overlap.
4. Prove old/new capability separation, signed-request canonicalization, nonce/replay rejection, and idempotency binding.
5. Atomically activate the new credential version. Revoke the old version after all in-flight receipts and notification registrations converge.
6. Record the rotation identifier, affected epochs, public fingerprints, and validation evidence in the controlled operations log.

## Suspected operational, membership, accounting, or parent-key loss

1. Set all environment permissions false and preserve audit data.
2. Revoke the affected credential version. For membership or parent compromise, increment the membership epoch and invalidate pairings, tokens, requests, and grants.
3. For accounting-key or anchor loss, keep starts fail closed. Reconcile the last committed server debit with protected high-water evidence before creating a replacement anchor.
4. Use the local administrator recovery flow to establish a new membership key and one-time QR. Never recover through an ordinary operational identity.
5. Re-pair parents and confirm old keys fail every operation.

## Windows service and package signing

1. Build with `npm run package:win:signed`; the release gate rejects absent signing configuration.
2. Verify the installer, packaged Electron executable, and packaged WinSW service wrapper all carry the expected publisher certificate. The installed wrapper is a byte-for-byte renamed copy of that packaged WinSW executable.
3. Validate the installed `PlaytimePactPrivilegedBroker` service reaches `Running` and accepts an authenticated named-pipe connection before promoting the package.
4. Reject a release when the wrapper, installer, or application signature is absent, invalid, expired without a trusted timestamp, or issued to a different publisher.

## Android release/update process

1. Build the release APK reproducibly from the approved source and dependency locks.
2. Sign the APK with the production Android release key in the controlled signing environment.
3. Verify APK digest and signer lineage independently.
4. Produce full update metadata containing application id, version code/name, minimum supported version, APK size, SHA-256 digest, signer lineage/fingerprint, release notes, URL, and issuance/expiry times.
5. Sign metadata with the independent update-manifest key.
6. Publish metadata and APK atomically, then test notice, bounded download, digest, signer lineage, version floor, and PackageInstaller handoff on minimum/latest supported Android versions.
7. Promote only after internal and one-household canaries pass.

## Android signing compromise or rollback

- Manifest-key compromise: stop publishing, remove the compromised verifier through a previously trusted application update, rotate the manifest key, and raise the supported version floor.
- APK-key compromise: halt Android distribution and remote privileged mutations; follow Android signer-lineage recovery only when the installed lineage and platform rules permit it.
- Bad release: withdraw metadata, publish a higher version signed by an accepted lineage, and never lower the supported version floor or accept a downgrade.
- Lost production credentials are a human operations gate. Debug signatures and local manifests are evidence only and must never be described as production release artifacts.
