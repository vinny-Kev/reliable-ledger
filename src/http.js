/** An error that is safe to show to the client: a status, a stable code and a message. */
export class ApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export const errorBody = (error) => ({ error: { code: error.code, message: error.message } });

// Express 5 forwards rejected promises from async handlers here, so handlers just throw.
export const errorHandler = (log = console.error) => (error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ApiError) return res.status(error.status).json(errorBody(error));
    if (error.type === 'entity.parse.failed') {
        return res.status(400).json(errorBody(new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON.')));
    }
    if (error.type === 'entity.too.large') {
        return res.status(413).json(errorBody(new ApiError(413, 'BODY_TOO_LARGE', 'Request body is too large.')));
    }
    // Never echo internal errors (SQL, stack traces) to the client.
    log(JSON.stringify({ level: 'error', event: 'unhandled_error', message: error.message, path: req.path }));
    return res.status(500).json(errorBody(new ApiError(500, 'INTERNAL', 'Something went wrong.')));
};
