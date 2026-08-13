# Windows 11 Remote Approval Provisioning

This runbook is the installer-to-provisioning handoff for one child PC. The installer contains only the generic provisioning script at:

```powershell
$Provision = "$env:ProgramFiles\Playtime Pact\resources\provisioning\provision-remote-approval.ps1"
```

It contains no household configuration, endpoint, token, private key, Firebase value, D1 identifier, or signing credential. Substitute the non-secret values shown in angle brackets at execution time; do not save credentials in the application directory or command history.

## Roles and prerequisites

- **Release operator:** provides the unsigned or signed Windows installer and its expected SHA-256.
- **Target Windows user:** the account that will run Playtime Pact. `NewPcIdentity`, `RegisterPc`, `ImportRegistration`, `VerifyConfig`, and pairing issuance must all run as this account because its two CNG private keys are non-exportable and user-scoped.
- **Setup-authority operator:** uses the separately controlled offline authority workstation. The setup-authority private key never reaches the child PC.
- **Parent:** uses the Android parent app only after PC registration and protected-config import.

Before starting, complete the Worker/D1 environment sequence in the deployment runbook: migrations, setup/operator public-authority bootstrap and verification, config validation, and Worker deployment. Keep environment and household permissions false except for an explicitly controlled pairing window.

Record these non-secret inputs:

```text
<installer-path>       internally approved Playtime Pact installer
<installer-sha256>     release-owner supplied SHA-256
<worker-base-url>      deployed HTTPS Worker origin, with no path/query
<household-id>         intended household identifier
<setup-actor-id>       registered setup-authority actor identifier
<setup-key-name>       setup-authority CNG key name on the authority workstation
<target-account>       DOMAIN\User or COMPUTER\User that runs Playtime Pact
<iana-time-zone>       household IANA timezone, for example America/New_York
```

## 1. Install on clean Windows 11

1. Sign in as `<target-account>` and verify the installer hash before execution:

   ```powershell
   (Get-FileHash -Algorithm SHA256 -LiteralPath '<installer-path>').Hash
   ```

   Compare it exactly with `<installer-sha256>`.

2. Run the per-machine installer. Do not edit files under the installation directory.
3. Stop Playtime Pact before importing or changing protected remote configuration:

   ```powershell
   Stop-Process -Name 'Playtime Pact' -ErrorAction SilentlyContinue
   Test-Path -LiteralPath $Provision -PathType Leaf
   ```

   `Test-Path` must return `True`.

Launching the app before provisioning is safe: when neither `PLAYTIME_PACT_REMOTE_CONFIG` nor `%ProgramData%\PlaytimePact\remote\config.json` exists, it starts in local-only mode.

## 2. Create the target-user PC identities

In a non-elevated PowerShell session as `<target-account>`:

```powershell
$identity = & $Provision -Action NewPcIdentity -IanaTimeZone '<iana-time-zone>' | ConvertFrom-Json
$identity
```

This creates exactly one stable `pcId`, one distinct `recoveryParentId`, and two non-exportable Microsoft Software KSP P-256 keys for that user. Re-running the command with the same inputs is a no-op. Do not copy CNG private material.

Transfer only these non-secret values to the setup-authority operator through the approved channel:

- `$identity.recoveryParentId`
- the public JWK file at `$identity.adminPublicJwk`
- `<household-id>` and `<worker-base-url>`

Keep `%LOCALAPPDATA%\PlaytimePact\remote\pending-enrollment.json` on the PC. It is consumed only after the exact Worker registration receipt has been verified and protected import succeeds.

## 3. Bootstrap the household from the authority workstation

On the offline setup-authority workstation, from the controlled operations checkout, open a network-enabled execution window only for this request and run:

```powershell
powershell -NoProfile -File scripts/invoke-remote-authority.ps1 `
  -Action SetupHousehold `
  -BaseUrl '<worker-base-url>' `
  -HouseholdId '<household-id>' `
  -InitialParentId '<recovery-parent-id-from-step-2>' `
  -InitialParentJwk '<approved-copy-of-admin-public-jwk>' `
  -SetupActorId '<setup-actor-id>' `
  -SetupKeyName '<setup-key-name>'
```

Verify a successful setup receipt. Return no private key, bearer token, or setup credential to the child PC. A signature from an unregistered setup authority must be treated as a hard stop.

## 4. Register the PC with the recovery-parent/admin identity

Back on the child PC, in non-elevated PowerShell as `<target-account>`:

```powershell
$registration = & $Provision `
  -Action RegisterPc `
  -BaseUrl '<worker-base-url>' `
  -HouseholdId '<household-id>' | ConvertFrom-Json
$registration
```

The script signs `POST /v1/pcs` with the target user's admin/recovery-parent CNG key and preserves the exact registration receipt at `%LOCALAPPDATA%\PlaytimePact\remote\registration-receipt.json`. Re-running identical inputs reuses that receipt; changed household, endpoint, PC identity, or public key must stop provisioning.

## 5. Import and verify the protected configuration

Keep Playtime Pact stopped. Elevate PowerShell **as the same `<target-account>`**, not as a different administrator account, then run:

```powershell
$import = & $Provision `
  -Action ImportRegistration `
  -BaseUrl '<worker-base-url>' `
  -HouseholdId '<household-id>' `
  -TargetAccount '<target-account>' | ConvertFrom-Json
$import

& $Provision -Action VerifyConfig
```

`ImportRegistration` validates the pending bundle, exact registration receipt, IDs, public JWKs, and positive membership/service epochs. It then writes `%ProgramData%\PlaytimePact\remote\config.json` atomically with Administrators/SYSTEM write access and target-user read access, opens and signs with both CNG keys through `VerifyConfig`, and only then removes the pending enrollment bundle. Do not start the app unless both commands succeed.

Exit the elevated shell. Start Playtime Pact normally as `<target-account>` and confirm remote approval reports an online/healthy Worker state. Configuration discovery order is:

1. an existing file named by `PLAYTIME_PACT_REMOTE_CONFIG` (diagnostic override);
2. an existing `%ProgramData%\PlaytimePact\remote\config.json`;
3. no file: documented local-only mode.

A present malformed or unreadable candidate is not treated as absent. Remote approval remains unavailable and the loader classifies it as `CONFIG_INVALID` or `CONFIG_UNREADABLE`; repair permissions/content or run the verified import again instead of bypassing it.

## 6. Pair the Android parent

After protected import and initial runtime health succeed, open only the minimum environment and household `respond_or_issue` permission window described in the deployment runbook. As `<target-account>`, issue a fresh pairing session:

```powershell
$pairing = & $Provision `
  -Action IssuePairing `
  -BaseUrl '<worker-base-url>' `
  -HouseholdId '<household-id>' `
  -PairingOperationKey ('pair-' + [Guid]::NewGuid().ToString()) | ConvertFrom-Json
$pairing
```

Enter or scan the returned pairing data in the Android parent app before expiry. The Android parent joins the existing household; it does not bootstrap the first PC. Immediately restore environment and household permissions to their approved least-privilege values.

## 7. Final runtime health checks

Confirm all of the following without modifying application files:

1. `& $Provision -Action VerifyConfig` succeeds as `<target-account>`.
2. Playtime Pact starts normally and remote health is online with the expected household/PC membership.
3. The Android app shows the paired PC and can refresh parent state.
4. A synthetic remote approval follows the configured permission tuple; no local timer/accounting state is lost.
5. Restart Playtime Pact and confirm the same membership and healthy remote state are loaded from ProgramData.

Record only timestamps, redacted identifiers, exit codes, and artifact/config hashes. Never record pairing tokens, private keys, service-account material, or signing credentials.

## Failure handling

- **No config file:** the app remains usable in local-only mode. Resume at the failed provisioning step.
- **`CONFIG_INVALID` / `CONFIG_UNREADABLE`:** remote approval is fail-closed. Stop the app, correct the protected file/ACL through `ImportRegistration`, and rerun `VerifyConfig`.
- **Identity, household, receipt, account, or JWK mismatch:** do not overwrite anything. Investigate the mismatch; use `ResetIdentity` only after explicit approval and exact `pcId` confirmation.
- **Import interrupted or ProgramData unwritable:** no partial protected config is accepted, and the pending bundle remains available for an identical retry.
- **App running during import:** stop the app and repeat the same import command.

## Rollback to local-only mode

Rollback does not erase local timer, policy, or usage data.

1. Stop Playtime Pact.
2. In elevated PowerShell as `<target-account>`, disable remote approval while retaining the protected identity for reconciliation/recovery:

   ```powershell
   & $Provision -Action Disable
   ```

3. Start Playtime Pact and verify local policy/timer behavior remains available while remote controls are unavailable.

Removing or disabling remote configuration returns the app to local-only operation. Do not delete the two CNG identities during normal rollback. Identity removal is destructive and requires an explicit request, the app stopped, elevation as the owning account, and exact confirmation:

```powershell
& $Provision -Action ResetIdentity -ConfirmPcId '<exact-pc-id>'
```

Coordinate backend membership cleanup separately; never infer it from local key removal.
