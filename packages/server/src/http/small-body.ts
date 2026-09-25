import { bodyLimit } from 'hono/body-limit';

import { ApiError } from './errors.ts';

/** JSON requests (auth, account) are small; anything bigger is refused before it is read. */
const MAX_JSON_BODY_BYTES = 16 * 1024;

/** Per route (not `use('*')`), so it never applies to the large bundle uploads (T16). */
export const smallBody = () =>
  bodyLimit({
    maxSize: MAX_JSON_BODY_BYTES,
    onError: () => {
      throw new ApiError(413, 'payload_too_large', 'Request body is too large');
    },
  });
