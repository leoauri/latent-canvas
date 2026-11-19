"
FFI bindings for redaw_peer.dll (see redaw-peer/include/redaw_peer.h): a native peer that joins a redaw (latent-canvas) session's WebRTC room and keeps its Automerge document in sync.

Use RedawPeer rather than these calls directly. Strings passed in must be UTF-8 (squeakToUtf8). Text comes back through caller-provided ByteArrays (the *_buf functions), so nothing allocated by the library leaks.

If the DLL is not next to the VM, tell it where it is:
	RedawPeerLibrary modulePath: 'C:\path\to\redaw_peer.dll'
"
Class {
	#name : #RedawPeerLibrary,
	#superclass : #ExternalLibrary,
	#classVars : [
		'ModulePath'
	],
	#category : #'Redaw-Peer',
	#'squeak_changestamp' : 'redaw 11/19/2026 12:00'
}

{ #category : #accessing }
RedawPeerLibrary class >> moduleName [
	"redaw_peer.dll next to the VM, unless set with #modulePath:."
	^ ModulePath ifNil: ['redaw_peer.dll']
]

{ #category : #accessing }
RedawPeerLibrary class >> modulePath: aString [
	"Where redaw_peer.dll is, e.g. 'C:\Users\me\redaw-peer\target\release\redaw_peer.dll'."
	ModulePath := aString.
	self resetDefault
]

{ #category : #primitives }
RedawPeerLibrary >> close: aPeer [
	<cdecl: void 'rp_close' (void*)>
	^ self externalCallFailed
]

{ #category : #primitives }
RedawPeerLibrary >> delete: aPeer path: pathString [
	<cdecl: int32_t 'rp_delete' (void* char*)>
	^ self externalCallFailed
]

{ #category : #primitives }
RedawPeerLibrary >> get: aPeer path: pathString into: aByteArray capacity: anInteger [
	<cdecl: int64_t 'rp_get_buf' (void* char* void* int64_t)>
	^ self externalCallFailed
]

{ #category : #primitives }
RedawPeerLibrary >> isSynced: aPeer [
	<cdecl: int32_t 'rp_is_synced' (void*)>
	^ self externalCallFailed
]

{ #category : #helpers }
RedawPeerLibrary >> lastError [
	"The library's last error message, or nil."
	^ self readText: [:buffer :capacity | self lastErrorInto: buffer capacity: capacity] ifAbsent: [nil]
]

{ #category : #primitives }
RedawPeerLibrary >> lastErrorInto: aByteArray capacity: anInteger [
	<cdecl: int64_t 'rp_last_error_buf' (void* int64_t)>
	^ self externalCallFailed
]

{ #category : #primitives }
RedawPeerLibrary >> open: linkString name: nameString store: storeStringOrNil [
	<cdecl: void* 'rp_open' (char* char* char*)>
	^ self externalCallFailed
]

{ #category : #primitives }
RedawPeerLibrary >> put: aPeer path: pathString json: jsonString [
	<cdecl: int32_t 'rp_put' (void* char* char*)>
	^ self externalCallFailed
]

{ #category : #helpers }
RedawPeerLibrary >> readText: aBlock ifAbsent: absentBlock [
	"aBlock fills a buffer and answers the text's full length (-1 = absent, -2 = error). Retry with a bigger buffer when it did not fit."
	| buffer length |
	buffer := ByteArray new: 4096.
	[length := aBlock value: buffer value: buffer size.
	 length > buffer size] whileTrue: [buffer := ByteArray new: length + 1024].
	length = -1 ifTrue: [^ absentBlock value].
	length < 0 ifTrue: [^ self error: 'redaw-peer: ', (self lastError ifNil: ['unknown error'])].
	length = 0 ifTrue: [^ absentBlock value].
	^ (buffer copyFrom: 1 to: length) asString utf8ToSqueak
]

{ #category : #primitives }
RedawPeerLibrary >> saveFile: aPeer path: pathString [
	<cdecl: int32_t 'rp_save_file' (void* char*)>
	^ self externalCallFailed
]

{ #category : #primitives }
RedawPeerLibrary >> status: aPeer into: aByteArray capacity: anInteger [
	<cdecl: int64_t 'rp_status_buf' (void* void* int64_t)>
	^ self externalCallFailed
]

{ #category : #primitives }
RedawPeerLibrary >> version: aPeer [
	<cdecl: uint64_t 'rp_version' (void*)>
	^ self externalCallFailed
]

{ #category : #primitives }
RedawPeerLibrary >> waitSynced: aPeer timeout: milliseconds [
	<cdecl: int32_t 'rp_wait_synced' (void* uint32_t)>
	^ self externalCallFailed
]
