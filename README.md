# PingRoom booklet imposition starter

Turn an ordered page manifest into a booklet sheet map after a named print operator chooses binding and signature size in PingRoom. Use it between an editorial page list and a renderer that you control.

This starter exports JSON page positions. It does not read PDFs, render documents, send printer commands or print anything.

## Try it offline

Choose **Use this template**, clone your repository, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

Four demos use the real SDK with local mock transport: left binding, right binding, small signatures and Unknown. They require no credentials and do not test live phone delivery. `@pingroom/sdk` 0.7.1 is pinned with a lockfile; `.npmrc` requests a 14-day minimum release age where npm supports it. GitHub Actions checks Node 22 and 24.

## Define the document

```sh
cp examples/document.json document.json
cp config.example.json config.json
npm run validate
```

Edit `document.json` before collecting answers:

```json
{
  "documentId": "workshop-v1",
  "title": "Workshop guide",
  "pages": [
    { "id": "cover", "label": "Front cover" },
    { "id": "welcome", "label": "Welcome" }
  ]
}
```

The `pages` array contains 1–64 pages in reading order. Include covers and intentional source blanks as ordinary page records. Unique page IDs use 1–24 lowercase ASCII characters starting with a letter, then letters, digits, `_` or `-`; prototype-related names are excluded. `documentId` uses the same character pattern with a 40-character limit. Title and labels allow 40 UTF-16 units of trimmed single-line Unicode. Controls, formatting characters, malformed Unicode and extra properties are rejected.

Use a document ID for the exact edition. Reordering pages changes the session. Hashes bind page metadata, order and policy, **not actual document bytes**. Your renderer must map page IDs to the intended document revision.

## Connect the operator

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Open the pairing link, approve the connection and grant a standard private room containing the operator. Verify the person in the app, then copy their exact member UUID into `config.json`. Names alone do not establish identity. The connection needs room/Question access; retain its original asking registration for later reads.

Pairing resumes pending requests and saves credentials under `.pingroom/`. For an existing connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. A complete pair overrides saved credentials. Partial or blank shell pairs cannot borrow from `.env` or the saved connection.

## Collect and export

```sh
npm start
# Answer in PingRoom, then record the answer:
npm start
# Run again to ask the next setting, then again after answering.
npm run status
npm run report
npm run export
```

Each `npm start` creates at most one Question or reads the active one once. It asks these two settings in order:

| Setting | Exact replies |
| --- | --- |
| Binding edge of the closed booklet | `Left`, `Right`, `Unknown` |
| Maximum pages per separately folded signature | `4`, `8`, `12`, `16`, `Unknown` |

Prompts include document identity, page count and page-manifest hash. Each direct Question lasts 900 seconds. Prompts fit 500 characters, context fits 40, and text input allows 60. There is no background polling. Parsing checks PingRoom's normalized text and cannot detect whitespace trimmed by the server.

Both settings need valid known answers. Missing, Unknown, invalid, expired or cancelled answers withhold the whole mapping. The later setting can still be collected, but terminal Questions are never automatically reissued.

`status` prints evidence offline. `report` also saves `.booklet/report.json`. `export` writes `.booklet/proposal.json` only when complete, retaining the source manifest, policy hashes, room, operator, answers, Question IDs and timestamps. Repeated exports are identical. Failed exports preserve existing files; require success for the expected source hash.

## Read the sheet map

[Adobe's booklet guide](https://helpx.adobe.com/acrobat/desktop/print-documents/booklets-posters-banners/print-booklets.html) describes the convention used here: two pages per sheet face for folding, with left/right binding.

A signature is a group of sheets nested and folded together. Chunk the manifest at the chosen capacity. Pad only the last partial signature to the next multiple of four, adding explicit blanks at its reading-order end. Nine pages at capacity eight become signatures of eight and four pages, with three blanks.

For eight pages with left binding:

| Sheet, outside to inside | Front left / right | Back left / right |
| --- | --- | --- |
| 1 | 8 / 1 | 2 / 7 |
| 2 | 6 / 3 | 4 / 5 |

Each face is viewed from its own printed side. Right binding mirrors each pair. Fold and nest sheets **within each signature**, then gather signatures in their recorded order. Multiple signatures are not one nested stapled booklet.

`plan.signatures[].sheets[]` includes `front.left`, `front.right`, `back.left` and `back.right`. Each slot has a local `signaturePage`. A source-page slot also has `pageId`, `label` and original one-based `sourceIndex`; a blank has `kind: "blank"` and null source fields. Sheet indices restart per signature; `sheetNumber` runs through the whole document.

Adapt orientation and duplex handling to your renderer and printer, then test-fold a numbered proof. The map specifies no driver flip-edge setting, rotations, creep, bleed, trim, paper thickness or finishing suitability.

## Recover and adapt

Keep the original manifest, config, connection and `.booklet/` state. Changed manifest content, policy or identities cannot reuse answers; document-byte changes alone are undetected. Creation intent is saved before POST. For uncertain creation:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

An empty recent-list search does not prove creation failed. Recovery checks the original Question without another POST. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pairing record.

Use persistent storage on one machine. Restore corrupt state from backup; remove stale locks only after confirming their process stopped. Credentials, inputs and state are Git-ignored. Writes are private and atomic. Limits: manifest 64 KiB, config 16 KiB, state/reports 1 MiB and HTTP responses 512 KiB. Evidence is historical, not tamper-proof.

Collection exits `0` when complete, `1` on error, `2` for incomplete/newly failed outcomes, `3` while ready/pending/interrupted and `4` for uncertain creation. Successful offline commands exit `0`; refused exports exit `1`.

Adapt the manifest and consume the reviewed proposal in your own renderer. Keep rules in application code and version `POLICY` when semantics change. The [SDK contract](https://github.com/pingroom/sdk) was checked on 2026-11-08. Tests cover 512 independent folded-reading combinations, fixed sheet pairs, recovery, pairing and CLI subprocesses. [MIT license](LICENSE).
