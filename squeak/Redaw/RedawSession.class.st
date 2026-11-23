"
A live view of a redaw (latent-canvas) session for inspecting: the shared document, the layer stack and the timeline's clips with their latents, kept up to date by a background process while the browsers in the room change it.

	session := RedawSession link: '<invite link>'.
	session inspect.
	(session clips first) frames.		""an Array of FloatArrays, one per latent frame""
	(session clips first) dimension: 1.	""one latent dimension over time""
	session close.

Inspectors on the session (and on what you open from it: the document's maps, the clips) update by themselves: the document, layers and clips are updated in place, not replaced. The latents are fetched from the room's blob store as clips appear.
"
Class {
	#name : #RedawSession,
	#superclass : #Object,
	#instVars : [
		'peer',
		'name',
		'document',
		'layers',
		'clips',
		'version',
		'updated',
		'process',
		'lastError'
	],
	#category : #'Redaw-Peer',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession class >> link: linkString [
	^ self link: linkString name: 'Squeak'
]

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession class >> link: linkString name: nameString [
	"Join the session and start following it."
	^ self on: (RedawPeer link: linkString name: nameString)
]

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession class >> on: aRedawPeer [
	^ self new setPeer: aRedawPeer
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> clipAt: idString [
	^ clips detect: [:c | c id = idString] ifNone: [nil]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> clips [
	"The timeline's clips in draw order, RedawClips with their latents (live)."
	^ clips
]

{
	#category : #lifecycle,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> close [
	"Stop following and leave the room."
	self stop.
	peer close
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> document [
	"The whole shared document: { meta, state, code } (live)."
	^ document
]

{
	#category : #lifecycle,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawSession >> isRunning [
	^ process notNil and: [process isTerminated not]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> lastError [
	^ lastError
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> layers [
	"The layer stack, back to front (live)."
	^ layers
]

{
	#category : #private,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> merge: newValue into: oldDictionary [
	"Make oldDictionary equal to newValue (a Dictionary), keeping the identity of nested dictionaries that are still there, so inspectors on them stay live."
	(oldDictionary keys reject: [:k | newValue includesKey: k]) do: [:k | oldDictionary removeKey: k].
	newValue keysAndValuesDo: [:k :v | | old |
		old := oldDictionary at: k ifAbsent: [nil].
		((old isKindOf: Dictionary) and: [v isKindOf: Dictionary])
			ifTrue: [self merge: v into: old]
			ifFalse: [old = v ifFalse: [oldDictionary at: k put: v]]]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> name [
	"The session's name (meta/name)."
	^ name
]

{
	#category : #private,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> ordered: aCollectionJson [
	"The items of an {order, items} collection in the document, in order."
	| items |
	aCollectionJson ifNil: [^ #()].
	items := aCollectionJson at: 'items' ifAbsent: [^ #()].
	^ (aCollectionJson at: 'order' ifAbsent: [items keys asArray])
		select: [:k | items includesKey: k]
		thenCollect: [:k | items at: k]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> peer [
	^ peer
]

{
	#category : #printing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> printOn: aStream [
	aStream nextPutAll: 'a RedawSession('; print: name; nextPutAll: ', ';
		print: layers size; nextPutAll: ' layers, ';
		print: clips size; nextPutAll: ' clips ('; print: (clips count: [:c | c isLoaded]); nextPutAll: ' loaded), v';
		print: version.
	process ifNil: [aStream nextPutAll: ', stopped'].
	aStream nextPut: $)
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> refresh [
	"Take the document from the peer, updating what the inspectors show in place."
	| doc state |
	doc := peer document ifNil: [^ self].
	document ifNil: [document := doc] ifNotNil: [self merge: doc into: document].
	name := (document at: 'meta' ifAbsent: [nil]) ifNotNil: [:m | m at: 'name' ifAbsent: [nil]].
	state := document at: 'state' ifAbsent: [JsonObject new].
	self updateLayers: (state at: 'stack.layers' ifAbsent: [nil]).
	self updateClips: (state at: 'timeline.clips' ifAbsent: [nil]).
	updated := DateAndTime now.
	lastError := nil
]

{
	#category : #lifecycle,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:52'
}
RedawSession >> reopen [
	"Join the room again (e.g. after an image restart) and follow it."
	peer reopen.
	self start
]

{
	#category : #private,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> setPeer: aRedawPeer [
	peer := aRedawPeer.
	clips := OrderedCollection new.
	layers := OrderedCollection new.
	version := 0.
	self start
]

{
	#category : #lifecycle,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> start [
	"Follow the session in a background process (polls the peer's version, so no network thread calls into the VM)."
	self stop.
	process := [[peer isOpen] whileTrue: [
			[self step] on: Error do: [:e | lastError := e messageText].
			(Delay forMilliseconds: 200) wait]]
		forkAt: Processor userBackgroundPriority named: 'RedawSession'
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> status [
	^ peer status
]

{
	#category : #updating,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> step [
	"Refresh when the document changed; keep loading latents that are still on their way."
	| v |
	v := peer version.
	v ~= version ifTrue: [version := v. self refresh].
	clips do: [:c | c isLoaded ifFalse: [c loadFrom: peer]]
]

{
	#category : #lifecycle,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> stop [
	process ifNotNil: [process terminate. process := nil]
]

{
	#category : #private,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> updateClips: aCollectionJson [
	"clips in draw order, a RedawClip each, kept (with its latents) as long as its id stays."
	| byId new |
	byId := Dictionary new.
	clips do: [:c | byId at: c id put: c].
	new := (self ordered: aCollectionJson) collect: [:json |
		(byId at: (json at: 'id' ifAbsent: [nil]) ifAbsent: [nil])
			ifNil: [RedawClip fromJson: json]
			ifNotNil: [:c | c updateFrom: json. c]].
	(new size = clips size and: [(1 to: new size) allSatisfy: [:i | (new at: i) == (clips at: i)]])
		ifFalse: [clips removeAll; addAll: new]
]

{
	#category : #private,
	#'squeak_changestamp' : 'jl-MCPServer 11/19/2026 16:47'
}
RedawSession >> updateLayers: aCollectionJson [
	"layers is the stack back to front: the document's layer maps (live)."
	| new |
	new := self ordered: aCollectionJson.
	(new size = layers size and: [(1 to: new size) allSatisfy: [:i | (new at: i) == (layers at: i)]])
		ifFalse: [layers removeAll; addAll: new]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:20'
}
RedawSession >> updated [
	"Set once a refresh has merged the document, so a reader polling it never sees a half-merged one."
	^ updated
]
