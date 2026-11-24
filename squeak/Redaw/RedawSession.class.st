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
		'lastError',
		'encoder'
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
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
RedawSession >> addClipFromSound: aSound t: seconds [
	"Below the lowest clip."
	^ self addClipFromSound: aSound t: seconds y: self yBelowClips
]

{
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawSession >> addClipFromSound: aSound t: seconds y: worldY [
	"Encode aSound with the session's encoder and add it to the timeline as a clip at seconds, worldY (px). Waits (yielding) for the encoding. Answer the clip's id; its latents are served from this session's peer, so keep it open until the others have them."
	| enc |
	enc := self encoder.
	^ peer
		addClipLatents: (enc latentsOfSound: aSound)
		dim: enc channels
		rate: enc frameRate
		t: seconds
		y: worldY
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
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawSession >> close [
	"Stop following and leave the room."
	self stop.
	encoder ifNotNil: [encoder close. encoder := nil].
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
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
RedawSession >> encoder [
	"The session's encoder (see #encoderLayer), loaded once; waits (yielding) for its files to arrive from the room."
	| deadline |
	deadline := Time millisecondClockValue + 60000.
	[self encoderIfReady] whileNil: [
		Time millisecondClockValue > deadline ifTrue: [
			^ self error: (self encoderLayer ifNil: ['no encoder layer in the session'] ifNotNil: ['the encoder''s files did not arrive from the room'])].
		(Delay forMilliseconds: 100) wait].
	^ encoder
]

{
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
RedawSession >> encoderIfReady [
	"The session's encoder (see #encoderLayer) if it is loaded; else start fetching its files from the room and answer nil. Never waits."
	| layer |
	(encoder notNil and: [encoder isOpen]) ifTrue: [^ encoder].
	layer := self encoderLayer ifNil: [^ nil].
	^ encoder := RedawEncoder forLayer: layer peer: peer
]

{
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 12:30'
}
RedawSession >> encoderLayer [
	"The first operator layer whose model encodes audio, or nil. Its config is fetched from the room if it is not here: answers nil until it is."
	^ layers detect: [:each | | hashes config |
		(each at: 'type' ifAbsent: [nil]) = 'operator' and: [
			hashes := (each at: 'model' ifAbsent: [JsonObject new]) at: 'hashes' ifAbsent: [JsonObject new].
			config := hashes keys detect: [:name | name endsWith: '.anira.json'] ifNone: [nil].
			config notNil and: [
				peer fetchBlob: (hashes at: config).
				(peer blobAt: (hashes at: config))
					ifNil: [false]
					ifNotNil: [:bytes | RedawEncoder isEncoderConfig: bytes asString]]]]
		ifNone: [nil]
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

{
	#category : #encoding,
	#'squeak_changestamp' : 'MCPServer (SqueakXR) 11/24/2026 13:49'
}
RedawSession >> yBelowClips [
	"World y for a new clip: below the lowest clip."
	^ clips inject: 0 into: [:max :c | max max: (c y ifNil: [0]) + 30]
]
