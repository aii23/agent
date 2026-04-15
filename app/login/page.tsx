"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSignMessage } from "wagmi";
import { SiweMessage } from "siwe";
import { signIn, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, Wallet, LogOut } from "lucide-react";

export default function LoginPage() {
  const { address, isConnected, chain } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { mutateAsync: signMessageAsync } = useSignMessage();
  const { status } = useSession();
  const router = useRouter();

  const [isSigning, setIsSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "authenticated") router.replace("/");
  }, [status, router]);

  const handleConnect = () => {
    const injected = connectors.find((c) => c.type === "injected");
    if (injected) connect({ connector: injected });
  };

  const handleSignIn = async () => {
    console.log("handleSignIn");
    if (!address || !chain) return;
    setIsSigning(true);
    setError(null);

    try {
      console.log("fetching nonce");
      const nonceRes = await fetch("/api/auth/nonce");
      if (!nonceRes.ok) throw new Error("Failed to fetch nonce");
      const { nonce } = await nonceRes.json();

      const siweMessage = new SiweMessage({
        domain: window.location.host,
        address,
        statement: "Sign in to Praxis Agents.",
        uri: window.location.origin,
        version: "1",
        chainId: chain.id,
        nonce,
      });

      const signature = await signMessageAsync({
        message: siweMessage.prepareMessage(),
      });

      const result = await signIn("credentials", {
        message: JSON.stringify(siweMessage),
        signature,
        redirect: false,
      });

      if (result?.error) {
        setError("Verification failed. Please try again.");
      }
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (
        msg.toLowerCase().includes("rejected") ||
        msg.toLowerCase().includes("denied")
      ) {
        setError("Signature request was rejected.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setIsSigning(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <span className="text-sm text-zinc-500 animate-pulse">Loading…</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center px-4">
      <div className="flex flex-col items-center gap-8 w-full max-w-sm">
        {/* Logo / Title */}
        <div className="flex flex-col items-center gap-3">
          <span className="font-mono font-bold text-xs tracking-widest text-zinc-100 bg-zinc-800 border border-zinc-700 px-3 py-1 rounded">
            PRAXIS
          </span>
          <div className="text-center">
            <h1 className="text-xl font-semibold text-zinc-100">Agents</h1>
            <p className="text-sm text-zinc-500 mt-1">
              Sign in with your Ethereum wallet
            </p>
          </div>
        </div>

        {/* Card */}
        <div className="w-full border border-zinc-800 rounded-lg bg-zinc-900 p-6 flex flex-col gap-5">
          {!isConnected ? (
            <div className="flex flex-col items-center gap-4">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-zinc-800">
                <Wallet className="w-5 h-5 text-zinc-400" />
              </div>
              <p className="text-sm text-zinc-400 text-center">
                Connect your wallet to continue
              </p>
              <Button
                onClick={handleConnect}
                className="w-full bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
              >
                Connect Wallet
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-zinc-800 mx-auto">
                <ShieldCheck className="w-5 h-5 text-zinc-400" />
              </div>

              {/* Connected address */}
              <div className="rounded-md bg-zinc-800/50 border border-zinc-700 px-3 py-2.5 flex items-center justify-between">
                <div className="flex flex-col gap-0.5">
                  <p className="text-xs text-zinc-500">Connected as</p>
                  <p className="text-sm font-mono text-zinc-100">
                    {address?.slice(0, 6)}…{address?.slice(-4)}
                  </p>
                  {chain && (
                    <p className="text-xs text-zinc-500">{chain.name}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-zinc-500 hover:text-zinc-100 hover:bg-zinc-700"
                  onClick={() => disconnect()}
                >
                  <LogOut className="w-3.5 h-3.5 mr-1" />
                  Disconnect
                </Button>
              </div>

              <p className="text-sm text-zinc-400 text-center">
                Sign a message to verify wallet ownership.
                <br />
                No transaction, no gas.
              </p>

              {error && (
                <p className="text-sm text-red-400 text-center">{error}</p>
              )}

              <Button
                onClick={handleSignIn}
                disabled={isSigning}
                className="w-full bg-zinc-100 text-zinc-900 hover:bg-zinc-200 disabled:opacity-50"
              >
                {isSigning ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Waiting for signature…
                  </>
                ) : (
                  "Sign In"
                )}
              </Button>
            </div>
          )}
        </div>

        <p className="text-xs text-zinc-600 text-center">
          Praxis Agents is an internal tool.
          <br />
          Access is restricted to authorized wallets.
        </p>
      </div>
    </div>
  );
}
