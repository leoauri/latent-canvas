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

/* Add bytes to the peer's blob store (served to peers that ask); name and mime may be NULL.
 * Writes the blob's id ("sha256-...") into buf: its length (nothing written if > cap), -2 error. */
int64_t rp_blob_put(RpPeer *peer, const uint8_t *bytes, int64_t len, const char *name, const char *mime, uint8_t *buf, int64_t cap);

/* Add a clip to the timeline, as the page's recorder does: count floats of frame-major latents
 * (dim per frame, rate frames/s) into the blob store, its metadata into state/timeline.clips at
 * t seconds and world y, in one change. Writes the clip's id into buf: its length, -2 on error.
 * The latents are served from this peer: keep it open until the others have them. */
int64_t rp_clip_add(RpPeer *peer, const float *latents, int64_t count, int32_t dim, double rate, double t, double y, uint8_t *buf, int64_t cap);

/* Models: an operator layer's streaming model (its ONNX file and anira config, fetched as blobs)
 * on worker threads. A decoder turns latents into audio, an encoder audio into latents. Submit a
 * job, then poll for its result. Both are RpModel handles: rp_decoder_close, _hop and _channels
 * work on either. */
typedef struct RpModel RpModel;
typedef RpModel RpDecoder;
typedef RpModel RpEncoder;
/* onnx: the model's bytes; config: the *.anira.json text; sample_rate: the meta's. NULL on error
 * (also for an encoder's model). */
RpDecoder *rp_decoder_open(const uint8_t *onnx, int64_t onnx_len, const char *config, int32_t sample_rate, int32_t threads);
void rp_decoder_close(RpModel *model);
/* Audio samples per latent frame; latent channels per frame. -1 on error. */
int32_t rp_decoder_hop(RpModel *model);
int32_t rp_decoder_channels(RpModel *model);
/* Queue count floats of frame-major latents at clip_rate frames/s (held onto the model's rate).
 * The job id (> 0), or -1. */
int64_t rp_decoder_submit(RpDecoder *decoder, const float *latents, int64_t count, double clip_rate);
/* The job's audio, 16-bit mono PCM: samples written (then the job is forgotten); if more than cap,
 * the count and nothing written (the job is kept). -1 while decoding, -2 on error. */
int64_t rp_decoder_pcm16(RpDecoder *decoder, int64_t job, int16_t *buf, int64_t cap);

/* As rp_decoder_open, for an encoder's model. NULL on error (also for a decoder's model). */
RpEncoder *rp_encoder_open(const uint8_t *onnx, int64_t onnx_len, const char *config, int32_t sample_rate, int32_t threads);
/* Queue count samples of mono audio at audio_rate samples/s (resampled to the model's rate), as
 * 16-bit PCM or floats in -1..1. The job id (> 0), or -1. */
int64_t rp_encoder_submit_pcm16(RpEncoder *encoder, const int16_t *pcm, int64_t count, double audio_rate);
int64_t rp_encoder_submit_f32(RpEncoder *encoder, const float *audio, int64_t count, double audio_rate);
/* The job's latents (frame-major float32, channels per frame, sample_rate / hop frames/s: a
 * clip's dataHash blob): floats written (then the job is forgotten); if more than cap, the count
 * and nothing written (the job is kept). -1 while encoding, -2 on error. */
int64_t rp_encoder_latents(RpEncoder *encoder, int64_t job, float *buf, int64_t cap);

#ifdef __cplusplus
}
#endif

#endif
