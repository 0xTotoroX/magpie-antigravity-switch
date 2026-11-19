# Antigravity Switch

[简体中文](README.md) · [MIT License](LICENSE)

View and switch local Antigravity desktop and CLI accounts from Magpie. The page follows Magpie's language and displays the accounts registered under its agy-cli provider.

## Install

Requires macOS, Magpie 0.1.2670 or later, and an existing Antigravity desktop or agy CLI sign-in. Open **Antigravity Switch** from the Magpie sidebar after installation.

From npm:

```sh
magpie plugin add npm:magpie-antigravity-switch@0.2.0
```

From GitHub:

```sh
magpie plugin add github:0xTotoroX/magpie-antigravity-switch#v0.2.0
```

## Accounts and quotas

**Refresh** syncs the agy-cli provider list and asks Magpie to refresh enabled accounts' quotas. Disabled accounts appear under **Unavailable accounts**. A failed refresh shows an error and keeps the previous quota while it remains valid.

The table shows the 5-hour and weekly windows reported for GPT / Claude, Gemini, and Gemini 4 Argon. Gemini 4 Carbon appears when a separate Carbon quota is returned. **Unknown**, **Needs refresh**, and **0%** represent different states. Google AI Pro, Ultra, and Enterprise plan names follow the provider's reading.

On macOS with local agy 1.5 or later, **CLI only** updates the Keychain sign-in used by new CLI processes and shared with the desktop app. Reconnect an existing CodexHost session to use the new CLI sign-in. A pending desktop change is marked until the running account can be verified.

Sign-ins and backups stay on this Mac. Existing Keychain access permissions are preserved. macOS may ask you to authorize access.

## Command line

The standalone CLI requires Node.js 24 or later.

```sh
npm install --global magpie-antigravity-switch@0.2.0
magpie-agy-switch status
magpie-agy-switch switch user@example.com --target=cli
```
