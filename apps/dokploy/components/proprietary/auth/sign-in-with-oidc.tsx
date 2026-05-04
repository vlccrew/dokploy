"use client";

import { LogIn } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

interface SignInWithOIDCProps {
	providerId: string;
	providerName: string;
}

export function SignInWithOIDC({
	providerId,
	providerName,
}: SignInWithOIDCProps) {
	const [isLoading, setIsLoading] = useState(false);

	const handleClick = async () => {
		setIsLoading(true);
		try {
			const { error } = await authClient.signIn.oauth2({
				providerId,
				callbackURL: "/dashboard/home",
			});
			if (error) {
				toast.error(error.message ?? `Failed to sign in with ${providerName}`);
			}
		} catch (err) {
			toast.error(`Failed to sign in with ${providerName}`, {
				description: err instanceof Error ? err.message : "Unknown error",
			});
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<Button
			variant="outline"
			type="button"
			className="w-full mb-4"
			onClick={handleClick}
			isLoading={isLoading}
		>
			<LogIn className="mr-2 size-4" />
			Sign in with {providerName}
		</Button>
	);
}
