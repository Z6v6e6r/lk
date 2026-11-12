# Public npm source fixtures

These are unmodified public package sources, not production flow exports.

- `client`, `messages-api`, `base-api`, `error`, `bot`, `polling`, `public-api`,
  `raw-api`, `bots-api`, `subscriptions-api`: `@maxhub/max-bot-api@0.2.2`, MIT,
  npm tarball shasum `ba27c84401372bddd2171404021710a562be4f81`.
  API internals are under `dist/core/network/api/`; messages, bots and subscriptions
  sources are `modules/<module>/api.js`. Bot/public-api are `dist/bot.js` and
  `dist/api.js`; Polling is `dist/core/network/polling.js`.
  License: `LICENSE-sdk.txt`.
- `maxbot-send`, `maxbot-receive`, `maxbot-config`: `node-red-contrib-maxbot@0.6.1`, MIT, author Kirov Ilya,
  `dist/nodes/<node-name>.js`. The npm package declares MIT but contains no
  separate LICENSE file; retain the notice below with this fixture.

Client and sender SHA256 match the installed source fingerprints established by
read-only diagnosis. No credentials, runtime payloads, original logs or flow IDs
are present. Tests evaluate these sources with mocked dependencies and fetch;
no npm package install or provider access is required.

MIT permission notice for the contrib fixture, attributed to Kirov Ilya:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
