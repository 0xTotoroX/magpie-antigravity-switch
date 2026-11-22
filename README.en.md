# Antigravity Switch

[简体中文](README.md) · [MIT License](LICENSE)

View and switch local Antigravity desktop and CLI accounts from Magpie. The page follows Magpie's language and displays the accounts registered under its agy-cli provider.

## What's new in 0.2.1

- Fixed a macOS reboot issue that could prevent Magpie from receiving quota refresh results.
- Account switching restores updated files after a failure and checks that credentials belong to the selected account.
- `switch --help` displays help, invalid switch options report an error, and the page keeps the latest refresh result.

## Install

Requires macOS, Magpie 0.1.2670 or later, and an existing Antigravity desktop or agy CLI sign-in. Open **Antigravity Switch** from the Magpie sidebar after installation.

From npm:

```sh
magpie plugin add npm:magpie-antigravity-switch@0.2.1
```

From GitHub:

```sh
magpie plugin add github:0xTotoroX/magpie-antigravity-switch#v0.2.1
```

## Accounts and quotas

**Refresh** syncs the agy-cli provider list and asks Magpie to refresh enabled accounts' quotas. Disabled accounts appear under **Unavailable accounts**. A failed refresh shows an error and keeps the previous quota while it remains valid.

The table shows the 5-hour and weekly windows reported for GPT / Claude, Gemini, and Gemini 4 Argon. Gemini 4 Carbon appears when a separate Carbon quota is returned. **Unknown**, **Needs refresh**, and **0%** represent different states. The plan badge uses the name returned by agy-cli. If the provider omits it, the plugin looks up the saved Antigravity sign-in for the same email and labels the plan **Last recorded**. You can view these records without switching accounts.

On macOS with local agy 1.5 or later, **CLI only** updates the Keychain sign-in used by new CLI processes and shared with the desktop app. Reconnect an existing CodexHost session to use the new CLI sign-in. A pending desktop change is marked until the running account can be verified.

Sign-ins and backups stay on this Mac. Existing Keychain access permissions are preserved. macOS may ask you to authorize access.

## Command line

The standalone CLI requires Node.js 24 or later.

```sh
npm install --global magpie-antigravity-switch@0.2.1
magpie-agy-switch status
magpie-agy-switch switch user@example.com --target=cli
```
