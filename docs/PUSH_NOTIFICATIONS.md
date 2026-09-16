# Push notifications

How a tournament check-in reaches a player whose app is closed.

## The problem this solves

A player registers for a tournament, closes the app, and puts the phone in a
pocket. Ninety minutes later check-in opens and they have a two-minute window
to confirm or lose their place.

Before this change the only announcement was a Socket.IO broadcast to the
tournament lobby channel. That reaches a client with a live connection which
has already opened the tournament screen — which is, by construction, none of
the people the notification is for. There was no socket, no inbox row, and no
push. Nothing happened at all.

Socket.IO cannot fix this, and no amount of reconnection logic makes it able
to: a terminated app has no process to hold a socket. Only the operating
system can draw a notification for an app that is not running, and the only way
to ask it to is Firebase Cloud Messaging.

## What happens when check-in opens

`tournamentLifecycleService.openCheckIn` moves the status with a conditional
update — so of two schedulers racing the deadline exactly one proceeds — and
then calls `tournamentCheckInNotifier.announceCheckIn`, which does three
things that are not alternatives to each other:

| Delivery | Reaches | Why it is not enough on its own |
|---|---|---|
| **Push** (FCM) | Any device, app running or not | Silently dropped if the player denied notification permission |
| **Inbox row** (`notifications`) | The next time the app is opened | Too late to act on a two-minute window |
| **Socket event** (`s:tournament:checkInOpened`, addressed) | A client already on the screen | Needs a live connection |

The recipient list is built from `TournamentRegistration` filtered by
`tournamentId`, so the morning tournament's check-in is delivered to the
morning tournament's entrants and to nobody else. Bots are excluded — they have
no phone — and so is anybody whose registration is `WITHDRAWN`, `NO_SHOW` or
`ELIMINATED`.

## Why a duplicate is impossible rather than unlikely

The scheduler is deliberately safe to run twice: a timer in the server process
and an external cron may both tick, and either can be retried after a crash.

The push is claimed before it is sent. `notificationLogs` has a unique index on
`userId + tournamentId + type`, and the send path inserts there first with
`insertMany({ ordered: false })`. A duplicate key means somebody else already
owns that recipient, so this process skips them. The insert *is* the claim —
one atomic operation, no read-then-write, no window.

The consequence is at-most-once rather than exactly-once: a crash between the
claim and the send loses that notification. That is the right trade. A player
who missed a nudge still has the countdown on the screen and the inbox row; a
player woken twice at 2am has been failed in a way they remember.

## Configuration

Both halves are required, and each fails silently without the other:

```
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----\n"

TOURNAMENT_CHECKIN_ENABLED=true
```

The three `FIREBASE_*` values come from **Firebase console → Project settings →
Service accounts → Generate new private key**, which downloads a JSON file;
copy `project_id`, `client_email` and `private_key` out of it. The private key
is a PEM block pasted as one line with its newlines written as the two
characters `\n`; `config/env.ts` converts them back.

`TOURNAMENT_CHECKIN_ENABLED` matters because the push fires on the transition
*into* `CHECK_IN`. With it off a tournament goes `REGISTRATION → STARTING →
RUNNING` and never enters that state, so there is nothing to fire on. It
defaults to true.

Leaving the `FIREBASE_*` values empty is supported: the server boots,
tournaments run, and every send is a logged no-op. That is the right
configuration for a dev machine and for the test suite.

After deploying, run the index sync once:

```
npm run sync-indexes
```

The unique indexes on `userDeviceTokens.token` and on
`notificationLogs.userId + tournamentId + type` are not optimisations — they
are what enforce "one row per device" and "one notification per person per
tournament". A deployment that skipped them would send duplicates on every
repeated scheduler tick.

## The device token

`POST /api/notifications/device-token` registers the handset the caller is
holding; `DELETE` retires it on sign-out. Both are authenticated and the owner
is always the token's bearer, never a field of the body — so a client can
register a device to itself and to nobody else.

The row is keyed on the **token**, not the user. A phone handed to somebody who
signs in as a guest keeps its FCM token, and keying on the user would leave
both rows alive and deliver the first player's notifications to a handset they
no longer hold. Keying on the token means the upsert moves it to whoever holds
the device now, which is the only reading that is ever correct.

The Flutter client calls `POST` on every launch, after sign-in, and on every
token refresh. All three land on the same upsert, so none of them has to check
whether the others ran.

## Debugging

Every log line is prefixed, so one grep answers one question:

| Prefix | Answers |
|---|---|
| `[FCM]` | Did Firebase start, was permission granted, was the token registered |
| `[TOURNAMENT_CHECKIN]` | Did the status change, when, did it trigger a fan-out |
| `[TOURNAMENT_NOTIFICATION]` | How many were eligible, how many tokens, how many sent/failed/skipped |

Registration tokens are masked to their last six characters wherever they are
printed. A token is a capability — whoever holds it can deliver a notification
to that handset — and logs are read in more places than the database is.

### When nothing arrives

Work down this list; each item is a complete explanation on its own.

1. `[FCM] firebase admin ready` missing from the server log → the service
   account is not configured, or its private key lost its newlines.
2. `TOURNAMENT_CHECKIN_ENABLED` is false → no tournament ever enters
   `CHECK_IN`, so nothing fires.
3. `[FCM] permissionStatus=denied` on the device → Android 13+ prompt was
   declined. The registration still happens; the system draws nothing.
4. `[FCM] tokenRegistered=false` → the device has no Play Services (common on
   emulators), or the app was offline at launch.
5. `[TOURNAMENT_NOTIFICATION] already announced` → the claim was taken by an
   earlier tick. This is the duplicate guard working, not a failure.
6. The notification arrives but is silent on a locked phone → the Android
   channel id disagrees somewhere. It is `tournament_notifications` in
   `constants/notification.constants.ts`, in the Flutter
   `NotificationService`, and in `AndroidManifest.xml`; Android silently
   ignores an id it has never been told about and delivers at default
   importance.
