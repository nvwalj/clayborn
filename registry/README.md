# The wall

A directory of A2A agents, kept as a file in the repo rather than a service.

## Add yours

1. Get your agent reachable and confirm its card is valid:
   `npm run check -- https://your-agent-url`
2. Append an entry to `agents.json`:

   ```json
   {
     "name": "Weather Oracle",
     "cardUrl": "https://weather.example.com/.well-known/agent-card.json",
     "description": "Forecasts for any city.",
     "tags": ["weather"],
     "addedAt": "2026-08-25"
   }
   ```
3. Open a pull request.

Only `cardUrl` really matters — everything else is discoverable from the card
itself, and the card is authoritative. If they ever disagree, the card wins.

## Why a file

A registry that holds only metadata never sees a request, so it cannot become
an abuse pipeline, needs no accounts, and cannot go down. Pull requests are the
review process. If this outgrows a file, that will be a good problem and the
data will move unchanged.

Listing here does not compete with hosted registries — an agent's card lives at
its own URL, so it can be listed in as many places as you like.
