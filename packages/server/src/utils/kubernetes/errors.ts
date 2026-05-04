export interface K8sHttpError {
	code: number;
	message?: string;
	body?: unknown;
}

export const isHttpError = (err: unknown): err is K8sHttpError => {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		typeof (err as { code: unknown }).code === "number"
	);
};
