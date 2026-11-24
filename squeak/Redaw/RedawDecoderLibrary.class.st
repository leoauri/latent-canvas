"
The decoder calls of redaw_peer.dll (see rp_decoder_* in redaw_peer.h), with a module path of its own: a newer build of the DLL can be loaded beside the one the running peers use.

	RedawDecoderLibrary modulePath: 'C:\path\to\redaw_peer-decoder.dll'
"
Class {
	#name : #RedawDecoderLibrary,
	#superclass : #RedawPeerLibrary,
	#classInstVars : [
		'modulePath'
	],
	#category : #'Redaw-Audio',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoderLibrary class >> moduleName [
	^ modulePath ifNil: ['redaw_peer.dll']
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoderLibrary class >> modulePath: aString [
	modulePath := aString.
	self resetDefault
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoderLibrary >> decoderChannels: aDecoder [
	<cdecl: int32_t 'rp_decoder_channels' (void*)>
	^ self externalCallFailed
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoderLibrary >> decoderClose: aDecoder [
	<cdecl: void 'rp_decoder_close' (void*)>
	^ self externalCallFailed
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoderLibrary >> decoderHop: aDecoder [
	<cdecl: int32_t 'rp_decoder_hop' (void*)>
	^ self externalCallFailed
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoderLibrary >> decoderOpen: onnxBytes length: anInteger config: configString sampleRate: rate threads: threads [
	<cdecl: void* 'rp_decoder_open' (void* int64_t char* int32_t int32_t)>
	^ self externalCallFailed
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoderLibrary >> decoderPcm16: aDecoder job: anInteger into: aByteArrayOrNil capacity: samples [
	<cdecl: int64_t 'rp_decoder_pcm16' (void* int64_t void* int64_t)>
	^ self externalCallFailed
]

{
	#category : #decoding,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
RedawDecoderLibrary >> decoderSubmit: aDecoder latents: aByteArray count: floats rate: aFloat [
	<cdecl: int64_t 'rp_decoder_submit' (void* void* int64_t double)>
	^ self externalCallFailed
]

{
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawDecoderLibrary >> encoderLatents: anEncoder job: anInteger into: aByteArrayOrNil capacity: floats [
	<cdecl: int64_t 'rp_encoder_latents' (void* int64_t void* int64_t)>
	^ self externalCallFailed
]

{
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawDecoderLibrary >> encoderOpen: onnxBytes length: anInteger config: configString sampleRate: rate threads: threads [
	<cdecl: void* 'rp_encoder_open' (void* int64_t char* int32_t int32_t)>
	^ self externalCallFailed
]

{
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawDecoderLibrary >> encoderSubmit: anEncoder pcm16: samples count: anInteger rate: aFloat [
	<cdecl: int64_t 'rp_encoder_submit_pcm16' (void* void* int64_t double)>
	^ self externalCallFailed
]
