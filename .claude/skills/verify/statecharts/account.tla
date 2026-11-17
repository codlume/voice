---- MODULE account ----
\* Settings > Account: Google sign-in, restore, sign out, and deletion.
\* Modeled from apps/desktop/src/main/account.ts and account-client.ts.

\* page is what the Account page shows. "launching" is the signedOut state a new process
\* starts in before restore() runs, and "waiting" and "finishing" are the two phases of signingIn.
\* cookie is the stored auth session: "live" while the server accepts it, "ended" once the
\* server expired or revoked it without Voice knowing yet.
\* queue is the encrypted retired_auth_sessions list. "ending" means a drain runs in this process,
\* "waiting" means the next launch, sign-in, or sign-out tries again.
\* attempted is attempts > 0, which decides whether a stray callback reads "Sign-in was interrupted".
VARIABLES page, cookie, queue, online, attempted

vars == <<page, cookie, queue, online, attempted>>

SigningIn == {"waiting", "finishing"}
ShownSignedIn == {"signedIn", "deleting"}

Init ==
  /\ page \in {"unavailable", "launching"}
  /\ cookie = "none"
  /\ queue = "empty"
  /\ online \in BOOLEAN
  /\ attempted = FALSE

\* restore(): the cached identity shows signed in before the server answers. Queued sign-outs drain.
Restore ==
  /\ page = "launching"
  /\ page' = IF cookie # "none" THEN "signedIn" ELSE "signedOut"
  /\ queue' = IF queue = "empty" THEN "empty" ELSE "ending"
  /\ UNCHANGED <<cookie, online, attempted>>

\* signIn() from signedOut, or from error through Retry. A fresh sign-in retires any stored cookie.
SignInStarts ==
  /\ page' = "waiting"
  /\ attempted' = TRUE
  /\ cookie' = "none"
  /\ queue' = IF cookie = "none" /\ queue = "empty" THEN "empty" ELSE "ending"
  /\ UNCHANGED online

\* A pasted code, a callback URL, or a second instance's argv, all with this attempt's state.
YourCodeArrives ==
  /\ page = "waiting"
  /\ page' = "finishing"
  /\ UNCHANGED <<cookie, queue, online, attempted>>

ServerAcceptsCode ==
  /\ page = "finishing"
  /\ online
  /\ page' = "signedIn"
  /\ cookie' = "live"
  /\ UNCHANGED <<queue, online, attempted>>

\* The browser does not open, the server rejects the code, or the server cannot be reached.
SignInFails ==
  /\ page \in SigningIn
  /\ page' = "error"
  /\ UNCHANGED <<cookie, queue, online, attempted>>

\* leave() aborts the exchange, and redeem() queues a cookie the server already set.
SignInLeft ==
  /\ page' = "signedOut"
  /\ cookie' = "none"
  /\ \/ queue' = queue
     \/ page = "finishing" /\ online /\ queue = "empty" /\ queue' = "waiting"
  /\ UNCHANGED <<online, attempted>>

YouCancel == page \in SigningIn /\ SignInLeft
TimesOut == page \in SigningIn /\ SignInLeft

\* handleCallbackUrl() in a process that has not started a sign-in and has no stored auth session.
OldCodeArrives ==
  /\ page \in {"launching", "signedOut"}
  /\ ~attempted
  /\ cookie = "none"
  /\ page' = "error"
  /\ UNCHANGED <<cookie, queue, online, attempted>>

YouClickSignIn == page \in {"launching", "signedOut"} /\ SignInStarts
YouRetry == page = "error" /\ SignInStarts

YouDismiss ==
  /\ page = "error"
  /\ page' = "signedOut"
  /\ UNCHANGED <<cookie, queue, online, attempted>>

\* signOut(): retireAuthSession() queues the cookie and forgets it, then the queue drains.
YouSignOut ==
  /\ page = "signedIn"
  /\ page' = "signedOut"
  /\ cookie' = "none"
  /\ queue' = "ending"
  /\ UNCHANGED <<online, attempted>>

VoiceEndsOldSignIn ==
  /\ queue = "ending"
  /\ online
  /\ queue' = "empty"
  /\ UNCHANGED <<page, cookie, online, attempted>>

OldSignInStaysQueued ==
  /\ queue = "ending"
  /\ queue' = "waiting"
  /\ UNCHANGED <<page, cookie, online, attempted>>

ServerEndsSignIn ==
  /\ cookie = "live"
  /\ cookie' = "ended"
  /\ UNCHANGED <<page, queue, online, attempted>>

\* checkAuthSession() at launch, on hub focus at most hourly, a name save answered 401, or the
\* deletion pre-check. forget() clears the cookie and the identity.
VoiceLearnsSignInEnded ==
  /\ page \in ShownSignedIn
  /\ online
  /\ cookie = "ended"
  /\ page' = "error"
  /\ cookie' = "none"
  /\ UNCHANGED <<queue, online, attempted>>

YouConfirmDeletion ==
  /\ page = "signedIn"
  /\ page' = "deleting"
  /\ UNCHANGED <<cookie, queue, online, attempted>>

ServerDeletesAccount ==
  /\ page = "deleting"
  /\ online
  /\ cookie = "live"
  /\ page' = "signedOut"
  /\ cookie' = "none"
  /\ UNCHANGED <<queue, online, attempted>>

\* Offline, a server error, a stale session that needs a new sign-in, or another account.
DeletionFails ==
  /\ page = "deleting"
  /\ page' = "signedIn"
  /\ UNCHANGED <<cookie, queue, online, attempted>>

\* dispose() and a new process. Drains in flight die, and the queue stays on disk.
YouRestart ==
  /\ page \notin {"unavailable", "finishing", "deleting"}
  /\ page' = "launching"
  /\ attempted' = FALSE
  /\ queue' = IF queue = "empty" THEN "empty" ELSE "waiting"
  /\ UNCHANGED <<cookie, online>>

NetworkDrops == online /\ online' = FALSE /\ UNCHANGED <<page, cookie, queue, attempted>>
NetworkReturns == ~online /\ online' = TRUE /\ UNCHANGED <<page, cookie, queue, attempted>>

Next ==
  \/ Restore
  \/ YouClickSignIn
  \/ YourCodeArrives
  \/ ServerAcceptsCode
  \/ SignInFails
  \/ YouCancel
  \/ TimesOut
  \/ OldCodeArrives
  \/ YouRetry
  \/ YouDismiss
  \/ YouSignOut
  \/ VoiceEndsOldSignIn
  \/ OldSignInStaysQueued
  \/ ServerEndsSignIn
  \/ VoiceLearnsSignInEnded
  \/ YouConfirmDeletion
  \/ ServerDeletesAccount
  \/ DeletionFails
  \/ YouRestart
  \/ NetworkDrops
  \/ NetworkReturns

\* The sign-in timer always runs, so a waiting sign-in ends.
Spec == Init /\ [][Next]_vars /\ WF_vars(TimesOut)

\* Rules.

SignedInOnlyWithStoredSignIn == page \in ShownSignedIn => cookie # "none"

SignedInOnlyWithLiveSignIn == page \in ShownSignedIn => cookie = "live"

SignedOutOnlyWithoutStoredSignIn == page = "signedOut" => cookie = "none"

LaunchShowsSignedOutOnlyWithoutStoredSignIn == page = "launching" => cookie = "none"

SignedOutKeepsNoToken == page = "signedOut" => queue = "empty"

EndedSignInLeavesNothingStored == page = "error" => cookie = "none"

ErrorOffersRetryAndDismiss == page = "error" => (ENABLED YouRetry /\ ENABLED YouDismiss)

CancelReturnsToSignedOut ==
  page \in SigningIn => ENABLED (YouCancel /\ page' = "signedOut" /\ cookie' = "none")

OfflineNeverSignsOut ==
  [][(~online /\ cookie # "none" /\ page \in ShownSignedIn \cup {"launching"})
      => (page' \in ShownSignedIn \cup {"launching"} \/ YouSignOut \/ YouClickSignIn)]_vars

NoStuckSigningIn == page \in SigningIn ~> page \notin SigningIn

====
