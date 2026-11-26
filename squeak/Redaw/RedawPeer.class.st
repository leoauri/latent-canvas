"
A native peer in a redaw (latent-canvas) session. It joins the session's WebRTC room from its invite link (as copied from the Session window) and keeps the session's Automerge document in sync with the browsers in it.

Values are read and written as JSON at ""/""-separated paths into the document ({ meta: { name, created }, state: { <shared key>: ... } }).

	| peer |
	peer := RedawPeer link: 'http://localhost:5173/#doc=automerge:...&room=...&signal=...'.
	peer waitSynced: 20000.
	peer at: 'meta/name'.
	peer at: 'state/squeak.note' put: (Dictionary new at: 'text' put: 'hello from Squeak'; yourself).
	peer whenChangedDo: [Transcript showln: (peer jsonAt: 'state')].
	peer close.

Network work happens on the library's own threads; nothing blocks the VM except #waitSynced: and the open itself.
"
Class {
	#name : #RedawPeer,
	#superclass : #Object,
	#instVars : [
		'library',
		'handle',
		'link',
		'name',
		'store'
	],
	#classVars : [
		'Resume',
		'Stash'
	],
	#category : #'Redaw-Peer',
	#'squeak_changestamp' : 'redaw 11/19/2026 12:00'
}

{
	#category : #'class initialization',
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawPeer class >> initialize [
	"Take part in image snapshots, so no native handle is ever used after a reload."
	Smalltalk addToStartUpList: self.
	Smalltalk addToShutDownList: self
]

{ #category : #'instance creation' }
RedawPeer class >> link: linkString [
	"Join the session named by an invite link."
	^ self link: linkString name: 'Squeak'
]

{ #category : #'instance creation' }
RedawPeer class >> link: linkString name: nameString [
	^ self link: linkString name: nameString store: nil
]

{ #category : #'instance creation' }
RedawPeer class >> link: linkString name: nameString store: fileNameOrNil [
	"fileNameOrNil: a document saved with #save: to start from (fetched from the room otherwise)."
	^ self new setLink: linkString name: nameString store: fileNameOrNil
]

{
	#category : #snapshots,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawPeer class >> shutDown: quitting [
	"Before a snapshot. Stop the sessions' processes and take every native handle out of the peers: quitting, leave the rooms; otherwise keep the handles aside to put back in #startUp:."
	Resume := (RedawSession allInstances select: [:s | s isRunning]) asArray.
	Resume do: [:s | s stop].
	quitting
		ifTrue: [
			Stash := nil.
			Resume := nil.
			self allInstancesDo: [:p | [p close] on: Error do: [:e | p forgetHandle]]]
		ifFalse: [
			Stash := IdentityDictionary new.
			self allInstancesDo: [:p | p stashHandleIn: Stash]]
]

{
	#category : #snapshots,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawPeer class >> startUp: resuming [
	"After a snapshot. resuming: the image was started from the file; no handle from before is valid, nothing rejoins by itself (send #reopen). Otherwise (saved, still running): put the handles back and resume the sessions."
	| stash resume |
	stash := Stash.
	resume := Resume.
	Stash := nil.
	Resume := nil.
	resuming ifTrue: [
		self allInstancesDo: [:p | p forgetHandle].
		RedawSession allInstancesDo: [:s | s stop].
		RedawPeerLibrary resetDefault.
		^ self].
	stash ifNotNil: [self allInstancesDo: [:p | p restoreHandleFrom: stash]].
	resume ifNotNil: [resume do: [:s | s start]]
]

{
	#category : #clips,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawPeer >> addClipLatents: aByteArray dim: anInteger rate: framesPerSecond t: seconds y: worldY [
	"Add a clip to the timeline (on top), as the page's recorder does: its latents (little-endian float32, frame-major, anInteger per frame) are served from this peer, its metadata goes into the document, in one change. Answer the clip's id. Keep the peer open until the others have fetched the latents."
	| buffer size |
	self checkOpen.
	buffer := ByteArray new: 64.
	size := library clipAdd: handle latents: aByteArray count: aByteArray size // 4 dim: anInteger
		rate: framesPerSecond asFloat t: seconds asFloat y: worldY asFloat
		into: buffer capacity: buffer size.
	size < 0 ifTrue: [^ self error: 'redaw-peer: ', (library lastError ifNil: ['cannot add the clip'])].
	^ (buffer copyFrom: 1 to: size) asString
]

{ #category : #accessing }
RedawPeer >> at: pathString [
	"The value at pathString parsed from JSON (JsonObject, Array, String, Number, Boolean), or nil."
	^ (self jsonAt: pathString) ifNotNil: [:json | Json readFrom: json readStream]
]

{ #category : #accessing }
RedawPeer >> at: pathString put: anObject [
	"Write anObject (rendered as JSON) at pathString; it is synced to the room."
	self jsonAt: pathString put: (Json render: anObject).
	^ anObject
]

{
	#category : #blobs,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawPeer >> blobAt: hashString [
	"The blob's bytes (a ByteArray) if it is here completely, else nil (see #fetchBlob:)."
	self checkOpen.
	^ library
		readBytes: [:buffer :capacity | library blob: handle hash: hashString squeakToUtf8 into: buffer capacity: capacity]
		ifAbsent: [nil]
]

{
	#category : #blobs,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawPeer >> blobStatus: hashString [
	"Where a blob is: hash, state ('absent', 'waiting' for a peer that has it, 'fetching', 'done'), bytes, total, name, peers."
	self checkOpen.
	^ Json readFrom: (library
		readText: [:buffer :capacity | library blobStatus: handle hash: hashString squeakToUtf8 into: buffer capacity: capacity]
		ifAbsent: ['{}']) readStream
]

{
	#category : #private,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawPeer >> checkOpen [
	"Native handles are never used across an image save and reload: they are nilled before every snapshot (see RedawPeer class>>shutDown:). After a reload a peer stays closed until sent #reopen."
	(handle isNil or: [handle isNull]) ifTrue: [
		handle := nil.
		library := nil.
		self error: 'redaw-peer: closed (after an image restart, send #reopen)']
]

{
	#category : #lifecycle,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawPeer >> close [
	"Leave the room."
	| h |
	h := handle.
	handle := nil.
	(h notNil and: [h isNull not and: [library notNil]]) ifTrue: [library close: h].
	library := nil
]

{ #category : #accessing }
RedawPeer >> document [
	"The whole document."
	^ self at: ''
]

{
	#category : #blobs,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawPeer >> fetchBlob: hashString [
	"Start fetching a blob ('sha256-...', e.g. a clip's dataHash) from the room, unless it is here or on its way. Answers immediately; see #blobStatus: and #blobAt:."
	self checkOpen.
	(library blobFetch: handle hash: hashString squeakToUtf8) = 0
		ifFalse: [self error: 'redaw-peer: ', library lastError]
]

{
	#category : #snapshots,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawPeer >> forgetHandle [
	"After the image was started from a snapshot: the native peer of the old process is gone."
	handle := nil.
	library := nil
]

{
	#category : #status,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawPeer >> isOpen [
	^ handle notNil and: [handle isNull not]
]

{ #category : #status }
RedawPeer >> isSynced [
	"True once a peer has confirmed it has exactly our document."
	self checkOpen.
	^ (library isSynced: handle) = 1
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'SqueakXR 11/19/2026 16:00'
}
RedawPeer >> jsonAt: pathString [
	"The JSON text at pathString ('' = the whole document), or nil if nothing is there."
	
	self checkOpen.
	^ library
		readText: [:buffer :capacity | library get: handle path: pathString squeakToUtf8 into: buffer capacity: capacity]
		ifAbsent: [nil]
]

{ #category : #accessing }
RedawPeer >> jsonAt: pathString put: jsonString [
	self checkOpen.
	(library put: handle path: pathString squeakToUtf8 json: jsonString squeakToUtf8) = 0
		ifFalse: [self error: 'redaw-peer: ', library lastError]
]

{
	#category : #blobs,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawPeer >> latentsAt: hashString dim: anInteger [
	"A clip's latents (its dataHash blob: little-endian float32, frame-major) as an Array of FloatArrays, one per frame of anInteger values; nil if the blob is not here yet."
	^ (self blobAt: hashString) ifNotNil: [:bytes | RedawClip framesFrom: bytes dim: anInteger]
]

{ #category : #accessing }
RedawPeer >> link [
	^ link
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:00'
}
RedawPeer >> name [
	^ name
]

{
	#category : #printing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawPeer >> printOn: aStream [
	aStream nextPutAll: 'a RedawPeer('; nextPutAll: (self isOpen ifTrue: ['open'] ifFalse: ['closed']); nextPut: $)
]

{
	#category : #blobs,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawPeer >> putBlob: aByteArray name: nameStringOrNil type: mimeStringOrNil [
	"Add bytes to this peer's blob store, served to the others when they ask. Answer the blob's id ('sha256-...'). The blob lives as long as this peer stays open."
	| buffer size |
	self checkOpen.
	buffer := ByteArray new: 80.
	size := library blobPut: handle bytes: aByteArray length: aByteArray size
		name: (nameStringOrNil ifNotNil: [:s | s squeakToUtf8])
		type: (mimeStringOrNil ifNotNil: [:s | s squeakToUtf8])
		into: buffer capacity: buffer size.
	size < 0 ifTrue: [^ self error: 'redaw-peer: ', (library lastError ifNil: ['cannot store the blob'])].
	^ (buffer copyFrom: 1 to: size) asString
]

{ #category : #accessing }
RedawPeer >> removeKey: pathString [
	"Delete the map key or list item at pathString."
	self checkOpen.
	(library delete: handle path: pathString squeakToUtf8) = 0
		ifFalse: [self error: 'redaw-peer: ', library lastError]
]

{
	#category : #lifecycle,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/19/2026 15:12'
}
RedawPeer >> reopen [
	"Join the room again (after an image restart). The document is fetched from the peers again, or loaded from the store file if one was given."
	self setLink: link name: name store: store
]

{
	#category : #snapshots,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawPeer >> restoreHandleFrom: aDictionary [
	"After a snapshot, in the same VM: the native peer is still running; take its handle back."
	(aDictionary at: self ifAbsent: [nil]) ifNotNil: [:pair |
		handle := pair first.
		library := pair second]
]

{ #category : #lifecycle }
RedawPeer >> save: fileName [
	"Save the document (Automerge binary); RedawPeer link:name:store: loads it again."
	self checkOpen.
	(library saveFile: handle path: fileName squeakToUtf8) = 0
		ifFalse: [self error: 'redaw-peer: ', library lastError]
]

{
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/19/2026 15:12'
}
RedawPeer >> setLink: linkString name: nameString store: storeStringOrNil [
	link := linkString.
	name := nameString.
	store := storeStringOrNil.
	library := RedawPeerLibrary default.
	handle := library
		open: linkString squeakToUtf8
		name: nameString squeakToUtf8
		store: (storeStringOrNil ifNotNil: [:s | s squeakToUtf8]).
	(handle isNil or: [handle isNull]) ifTrue: [
		handle := nil.
		self error: 'redaw-peer: ', (library lastError ifNil: ['cannot open'])]
]

{
	#category : #snapshots,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawPeer >> stashHandleIn: aDictionary [
	"Before a snapshot: take the native handle out of the peer, so the saved image has none in use."
	handle ifNil: [^ self].
	aDictionary at: self put: {handle. library}.
	handle := nil.
	library := nil
]

{ #category : #status }
RedawPeer >> status [
	"Connection and sync status: self_id, doc, signal, peers (id, state, name, ...), heads, version, synced."
	self checkOpen.
	^ Json readFrom: (library
		readText: [:buffer :capacity | library status: handle into: buffer capacity: capacity]
		ifAbsent: ['{}']) readStream
]

{ #category : #status }
RedawPeer >> version [
	"Increases whenever the document or the connection status changes."
	self checkOpen.
	^ library version: handle
]

{
	#category : #blobs,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawPeer >> waitBlob: hashString timeout: milliseconds [
	"Fetch a blob and block (the whole VM) up to milliseconds for it. Answers its bytes, or nil on timeout."
	| size |
	self checkOpen.
	size := library blobWait: handle hash: hashString squeakToUtf8 timeout: milliseconds.
	size = -2 ifTrue: [^ self error: 'redaw-peer: ', library lastError].
	^ size < 0 ifFalse: [self blobAt: hashString]
]

{ #category : #status }
RedawPeer >> waitSynced: milliseconds [
	"Block (the whole VM) up to milliseconds until synced; answer whether it is."
	self checkOpen.
	^ (library waitSynced: handle timeout: milliseconds) = 1
]

{ #category : #status }
RedawPeer >> whenChangedDo: aBlock [
	"Evaluate aBlock (in a background process) whenever the document or connections change, until closed. Answers the process."
	^ [| last |
		last := self version.
		[self isOpen] whileTrue: [
			(Delay forMilliseconds: 100) wait.
			(self isOpen and: [self version ~= last]) ifTrue: [
				last := self version.
				aBlock value]]] forkAt: Processor userBackgroundPriority named: 'RedawPeer changes'
]
