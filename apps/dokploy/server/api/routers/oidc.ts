import { getOidcPublicConfig } from "@dokploy/server/lib/auth";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";

export const oidcRouter = createTRPCRouter({
	publicConfig: publicProcedure.query(() => getOidcPublicConfig()),
});
