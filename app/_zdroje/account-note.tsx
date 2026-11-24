"use client";

import { useUser } from "@clerk/nextjs";
import { requestSignUp, useZdroje } from "./store";

/**
 * Above the setup guide: a visitor is told to make an account first (the
 * connector signs in under it), with "Zaregistrovat se"; a signed-in user
 * gets a short line that the account is there. Until Clerk loads, both,
 * and CSS shows the one the sign-in hint says (see ./hint.ts), as the
 * header does. Nothing on a deployment without Clerk.
 */
export function AccountNote() {
  const { auth } = useZdroje();
  if (auth === "none") return null;
  if (auth === "signed_out") return <RegisterBox />;
  if (auth === "loading") {
    return (
      <>
        <RegisterBox className="zd-hint-out" />
        <SignedInLine className="zd-hint-in" />
      </>
    );
  }
  return <SignedInUser />;
}

function RegisterBox({ className }: { className?: string }) {
  return (
    <div className={className ? `reg ${className}` : "reg"}>
      <div className="reg-text">
        <span className="reg-title">Nejdřív si založte účet</span>
        <span className="reg-desc">
          Dawmain se připojuje pod vaším účtem. Zaregistrujte se e-mailem nebo
          přes Google, pak pokračujte podle návodu níže.
        </span>
      </div>
      <button type="button" className="button reg-button" onClick={requestSignUp}>
        Zaregistrovat se
      </button>
    </div>
  );
}

/** Only rendered signed in, so inside ClerkProvider. */
function SignedInUser() {
  const { user } = useUser();
  const name = user?.fullName || user?.primaryEmailAddress?.emailAddress || null;
  return <SignedInLine name={name} />;
}

function SignedInLine({ name, className }: { name?: string | null; className?: string }) {
  return (
    <p className={className ? `reg-done ${className}` : "reg-done"}>
      <i aria-hidden="true" />
      {name ? `Účet máte, přihlášeni jako ${name}.` : "Účet máte."} Pokračujte
      podle návodu níže.
    </p>
  );
}
