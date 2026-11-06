// Calling a server action from a button. Safe for the browser: nothing here
// reaches the server on its own.

/** What callAction gives back when the call itself threw, so nothing is known about what happened. */
export type Unfinished = { ok: false; error: string; unfinished: true };

/**
 * A server action's own answer, or `failed` as an error when the call itself
 * throws: the connection dropped, the request timed out (a gateway's error
 * page is not the action's answer), the settings PIN ran out and the request
 * met the unlock page, or the page is older than the deployed app and posts
 * an action the new build doesn't know.
 *
 * Every button that awaits a server action inside a transition calls it
 * through here. React throws a transition's failure again while rendering,
 * so an uncaught one reached the error boundary and the whole tab became
 * "Something went wrong", with no word on whether the change was saved.
 * PRDashboard's Receive Insights met it first.
 */
export async function callAction<T>(call: () => Promise<T>, failed: string): Promise<T | Unfinished> {
  try {
    return await call();
  } catch (e) {
    console.error("A server action call did not finish", e);
    return { ok: false, error: failed, unfinished: true };
  }
}

/**
 * What a panel says when its call did not finish. `what` is the change that
 * may or may not have been made, such as "the Keep was saved", and `reload`
 * the page to look at again.
 */
export function notFinished(what: string, reload = "the page"): string {
  return `The request did not finish, so it is not known whether ${what}. Reload ${reload} to see what was saved before trying again.`;
}
