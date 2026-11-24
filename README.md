# Octobooth diner

Five diner-themed Copilot experiences for hands-on attendees and staff-led demos, available as a project-owned native Copilot canvas. See [running the diner](.github/extensions/octobooth-diner/README.md) for station configuration, QR entry, provisioning, and scoped teardown.

This public repository is an independent copy of [madebygps/chez-mona-ignite-26](https://github.com/madebygps/chez-mona-ignite-26). Chez Mona's original launcher, SDK starter, assets, attribution, and bundled licenses remain in their existing locations.

## Chez Mona launcher

| I want to | Read |
|---|---|
| Learn the basics before a booth shift | [Booth staff brief](launcher/docs/staff-brief.md) |
| Set up a laptop | [Set up a booth laptop](launcher/docs/setup.md) |
| Start, check or staff a laptop, or get lab counts | [Run the booth](launcher/docs/run-booth.md) |
| Understand the guest flow and the code | [How it works](launcher/docs/how-it-works.md) |

## Folders

| Path | Contents |
|---|---|
| [`.github/extensions/octobooth-diner/`](.github/extensions/octobooth-diner/) | Native diner canvas, shared five-dish catalog, and station lifecycle |
| [`launcher/`](launcher/) | The app for the cooking stations and the fridge kiosks |
| [`copilot-sdk/`](copilot-sdk/) | Microsoft Copilot SDK starter for the Fried Chicken lab. The launcher copies it for each guest. |
