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
	#category : #'Redaw-Peer',
	#'squeak_changestamp' : 'redaw 11/19/2026 12:00'
}

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
	#category : #private,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/19/2026 15:12'
}
RedawPeer >> checkOpen [
	"Native handles do not survive an image restart (they come back NULL): rejoin the room then."
	handle ifNil: [self error: 'redaw-peer: closed'].
	handle isNull ifTrue: [self reopen]
]

{
	#category : #lifecycle,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/19/2026 15:12'
}
RedawPeer >> close [
	"Leave the room."
	handle ifNil: [^ self].
	handle isNull ifFalse: [library close: handle].
	handle := nil
]

{ #category : #accessing }
RedawPeer >> document [
	"The whole document."
	^ self at: ''
]

{ #category : #status }
RedawPeer >> isOpen [
	^ handle notNil
]

{ #category : #status }
RedawPeer >> isSynced [
	"True once a peer has confirmed it has exactly our document."
	self checkOpen.
	^ (library isSynced: handle) = 1
]

{ #category : #accessing }
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

{ #category : #accessing }
RedawPeer >> link [
	^ link
]

{ #category : #printing }
RedawPeer >> printOn: aStream [
	aStream nextPutAll: 'a RedawPeer('; nextPutAll: (handle ifNil: ['closed'] ifNotNil: ['open']); nextPut: $)
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
