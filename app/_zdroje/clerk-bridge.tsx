"use client";

import { useAuth, useClerk } from "@clerk/nextjs";
import { useEffect, type ReactNode } from "react";
import { registerClerkActions, setAuth } from "./store";

/**
 * Connects Clerk to the shared Vlastní zdroje state (./store.ts). Mounted
 * once, inside ClerkProvider, only when Clerk is configured: it reports the
 * session state and registers the sign-in / account / sign-out actions, so
 * the nav, the home page and the modals never call Clerk hooks themselves
 * (which would throw on a deployment without Clerk).
 */
export function ClerkBridge() {
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();

  useEffect(() => {
    registerClerkActions({
      signIn: () => {
        const back = window.location.href;
        clerk.openSignIn({ forceRedirectUrl: back, signUpForceRedirectUrl: back });
      },
      manageAccount: () => clerk.openUserProfile(),
      signOut: () => {
        void clerk.signOut({ redirectUrl: "/" });
      },
    });
    return () => registerClerkActions(null);
  }, [clerk]);

  useEffect(() => {
    if (isLoaded) setAuth(isSignedIn ? "signed_in" : "signed_out");
  }, [isLoaded, isSignedIn]);

  return null;
}

/** Without Clerk on this deployment: tell the shared state there is no sign-in at all. */
export function NoClerk({ children }: { children?: ReactNode }) {
  useEffect(() => setAuth("none"), []);
  return children ?? null;
}
