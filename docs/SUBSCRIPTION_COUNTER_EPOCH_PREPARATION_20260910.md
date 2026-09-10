# New subscription-sales epoch: operator preparation

This packet prepares an independent allocation beginning at the timestamp in
`PADLHUB_SUBSCRIPTION_SALES_CONFIGURATION`. It does not deploy, mutate MongoDB,
or enable sales.

## Intended allocation

| Counter | New inventory | Visible limit |
| --- | --- | ---: |
| РА | `ab_leto_20260910_epoch_ra` | 10 per day |
| Дружба | `ab_leto_20260910_epoch_friendship` | 7 per day |
| ХАБ annual | `network_friendship_12m_20260910_epoch` | 1 per day, 100 total, 98,000 RUB |
| Питер annual | `piter_friendship_12m_20260910_epoch` | first batch 48 of 100, 400 total |

Both annual products retain Viva's next-day activation. Piter begins with a
`quotaAdjustment` of 52, which is a presentation and capacity offset only; it
does not import or alter prior payments.

## Required cutover sequence

1. Keep every sale flag off and drain or fence old in-flight admissions.
2. Re-read the deployed flow and compare it with the reviewed binding. Acquire
   the exclusive deployment lock.
3. Install the reviewed candidate while sales remain off.
4. At one shared `epochStartedAt` timestamp, create the two empty annual
   ledgers with `ready: false`; each insert must show no pre-existing document.
5. Verify the exact inactive postimages, then activate each ledger using its
   full-document compare-and-set. Do not upsert or repair old ledgers.
6. Set a V2 sales configuration with that exact timestamp and all four desired
   flags. Enable the common flag last.
7. Read back flags, attestation, ledgers, status API, and counter refresh. The
   first observable values must be 10, 7, 1, and 48 respectively.

Old sales are deliberately outside the new inventory counts. Their confirmation
path remains read-then-CAS against the exact native MongoDB row and never makes
a provider create-payment request.

## Preconditions that still require live evidence

- Fresh flow/hash and product readback immediately before deployment.
- A successful isolated MongoDB rehearsal of the empty-ledger activation CAS.
- A verified drain/fence for old payment creation and recovery requests.
- Separate authorization for deployment, MongoDB writes, and enabling sales.
