// Server-only capability: JSON request bodies cannot manufacture this key.
// The OGL service has already revalidated the batch, member IDs and ownership.
export const OGL_DISPATCH_REFRESH = Symbol('ogl-dispatch-refresh');
