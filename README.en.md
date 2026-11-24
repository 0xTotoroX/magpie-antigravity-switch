# Antigravity Switch

[简体中文](README.md) · [MIT License](LICENSE)

View and switch local Antigravity desktop and CLI accounts from Magpie. The page follows Magpie's language and displays the accounts registered under its agy-cli provider.

## What's new in 0.2.2

- Refresh quotas or switch existing accounts while another sign-in is waiting for its authorization code.
- A failed quota refresh shows the last valid reading with its update time.
- When agy-cli omits a plan name, the page labels the saved plan for the same account as “Last recorded.”
- Fixed the white background and control contrast in dark mode, reduced the Refresh button shadow, and simplified the Support action.

## Install

Requires macOS, Magpie 0.1.2670 or later, and an existing Antigravity desktop or agy CLI sign-in. Open **Antigravity Switch** from the Magpie sidebar after installation.

From npm:

```sh
magpie plugin add npm:magpie-antigravity-switch@0.2.2
```

From GitHub:

```sh
magpie plugin add github:0xTotoroX/magpie-antigravity-switch#v0.2.2
```

## Accounts and quotas

You can refresh quotas or switch an existing account while another Magpie sign-in is waiting for its authorization code.

**Refresh** syncs the agy-cli provider list and asks Magpie to refresh enabled accounts' quotas. Disabled accounts appear under **Unavailable accounts**. A failed refresh shows an error and keeps the previous quota while it remains valid.

The table shows the 5-hour and weekly quotas for GPT / Claude and Gemini. Gemini 4 Carbon appears when a valid separate reading is reported. Missing readings show a dash and expired readings show **Needs refresh**. The plan badge uses the name returned by agy-cli. If the provider omits it, the plugin looks up the saved Antigravity sign-in for the same email and labels the plan **Last recorded**. You can view these records without switching accounts.

On macOS with local agy 1.5 or later, **CLI only** updates the Keychain sign-in used by new CLI processes and shared with the desktop app. Reconnect an existing CodexHost session to use the new CLI sign-in. A pending desktop change is marked until the running account can be verified.

Sign-ins and backups stay on this Mac. Existing Keychain access permissions are preserved. macOS may ask you to authorize access.

## Command line

The standalone CLI requires Node.js 24 or later.

```sh
npm install --global magpie-antigravity-switch@0.2.2
magpie-agy-switch status
magpie-agy-switch switch user@example.com --target=cli
```
