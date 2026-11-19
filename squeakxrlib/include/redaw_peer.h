/* redaw_peer: a native peer for redaw (latent-canvas) sessions.
 *
 * Joins a session's WebRTC room from its invite link and keeps the session's Automerge document
 * in sync. Values are exchanged as JSON; paths are "/"-separated ("state/timeline.layers/order/0";
 * "~1" escapes "/", "~0" escapes "~"; "-" appends to a list).
 *
 * Errors: functions return NULL / -1 / -2 and leave the reason in rp_last_error().
 * Strings returned as char* belong to the caller: free them with rp_string_free().
 * The *_buf variants copy into a caller buffer instead and return the full length
 * (call again with a bigger buffer if it exceeds cap; no NUL is written).
 */
#ifndef REDAW_PEER_H
#define REDAW_PEER_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct RpPeer RpPeer;

/* Join a session. name (may be NULL) is shown to other peers; store (may be NULL) is a file the
 * document is loaded from if it exists (write it with rp_save_file). NULL on error. */
RpPeer *rp_open(const char *link, const char *name, const char *store);
/* Leave the room and free the peer. */
void rp_close(RpPeer *peer);

/* JSON at path ("" or NULL = the whole document). NULL if absent (rp_last_error() is then NULL)
 * or on error. */
char *rp_get(RpPeer *peer, const char *path);
/* Write a JSON value at path; synced to the room. 0 or -1. */
int32_t rp_put(RpPeer *peer, const char *path, const char *json);
/* Delete the map key or list item at path. 0 or -1. */
int32_t rp_delete(RpPeer *peer, const char *path);

/* A counter that increases whenever the document or the connection status changes. */
uint64_t rp_version(RpPeer *peer);
/* Block until the version exceeds since, or timeout_ms passes; returns the version. */
uint64_t rp_wait_change(RpPeer *peer, uint64_t since, uint32_t timeout_ms);
/* 1 once a peer has confirmed it has exactly our document, else 0. */
int32_t rp_is_synced(RpPeer *peer);
/* Block up to timeout_ms for rp_is_synced; returns it. */
int32_t rp_wait_synced(RpPeer *peer, uint32_t timeout_ms);
/* {"self_id","doc","signal","peers":[{"id","state","name","repo_peer","unavailable"}],
 *  "heads","version","synced","blobs":[blob status, see rp_blob_status_buf]} */
char *rp_status(RpPeer *peer);
/* Save the document (Automerge binary) to a file. 0 or -1. */
int32_t rp_save_file(RpPeer *peer, const char *path);

void rp_string_free(char *s);
/* The last error, or NULL. Valid until the next call into the library. */
const char *rp_last_error(void);

/* Buffer variants. rp_get_buf: length, -1 if absent, -2 on error. rp_status_buf: length or -2.
 * rp_last_error_buf: length, 0 if none. */
int64_t rp_get_buf(RpPeer *peer, const char *path, uint8_t *buf, int64_t cap);
int64_t rp_status_buf(RpPeer *peer, uint8_t *buf, int64_t cap);
int64_t rp_last_error_buf(uint8_t *buf, int64_t cap);

/* Blobs: what the document refers to by hash ("sha256-<64 hex>"), e.g. a clip's dataHash (its
 * latents: little-endian float32, frame-major, length x dim). Fetched from the room on the
 * library's threads; rp_version increases as a fetch moves on. */
/* Start fetching a blob (no-op if here or on its way). 0 or -1. */
int32_t rp_blob_fetch(RpPeer *peer, const char *hash);
/* The blob's bytes, if complete: its size (nothing written if > cap), -1 if not here, -2 error. */
int64_t rp_blob_buf(RpPeer *peer, const char *hash, uint8_t *buf, int64_t cap);
/* Fetch and block up to timeout_ms: size, -1 on timeout, -2 on error. Blocks the caller. */
int64_t rp_blob_wait(RpPeer *peer, const char *hash, uint32_t timeout_ms);
/* {"hash","state":"absent|waiting|fetching|done","bytes","total","name","peers"}: length or -2. */
int64_t rp_blob_status_buf(RpPeer *peer, const char *hash, uint8_t *buf, int64_t cap);

#ifdef __cplusplus
}
#endif

#endif
