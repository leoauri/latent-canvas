"
A RedawSession's canvas in XR: a flat plane in my XY plane, facing +z, centred on my origin, with page pixels mapped by metersPerPixel (time along +x at the page's default 100 px per second, the canvas' world y along -y).

What is drawn on it comes from features, each switched on and off on its own:

	view := SRRedawSessionView link: '<invite link>'.
	view openInFront.	""flat on the floor ahead of you""
	view toggle: SRRedawCodeChangesFeature.
	view disable: SRRedawNotesFeature.
	view enable: SRRedawNotesFeature.
	view metersPerPixel: 1/1000; step: 0; layOnFloor.
	view session close. view remove.

Every frame I ask the features whether they changed, grow the canvas to cover them, and relayout the ones that did.
"
Class {
	#name : #SRRedawSessionView,
	#superclass : #SRObject,
	#instVars : [
		'session',
		'plane',
		'features',
		'pageBounds',
		'metersPerPixel',
		'blockHeight',
		'transport'
	],
	#classVars : [
		'InviteLink'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #'xr menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:31'
}
SRRedawSessionView class >> askForInviteLinkThenOpenIn: aWorld [
	"The prompt is modal: in the XR process, which runs the menu, it would stop the frames it is drawn in."
	Project current addDeferredUIMessage: [| answer |
		answer := UIManager default
			request: 'Redaw invite link (from the session window of the page)'
			initialAnswer: self inviteLink.
		(answer isNil or: [answer withBlanksTrimmed isEmpty]) ifFalse: [
			[self inviteLink: answer.
			 aWorld addDeferredFrameMessage: [self switchTo: self inviteLink in: aWorld]]
				on: Error do: [:e | UIManager default inform: e messageText]]]
]

{
	#category : #'xr menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:31'
}
SRRedawSessionView class >> hostOf: aLink [
	| start rest end |
	start := aLink findString: '://'.
	start = 0 ifTrue: [^ 'session'].
	rest := aLink copyFrom: start + 3 to: aLink size.
	end := rest findFirst: [:c | c = $/ or: [c = $#]].
	^ end = 0 ifTrue: [rest] ifFalse: [rest first: end - 1]
]

{
	#category : #'xr menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:31'
}
SRRedawSessionView class >> in: aWorld [
	^ self allInstances detect: [:each | each world == aWorld] ifNone: [nil]
]

{
	#category : #preferences,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:31'
}
SRRedawSessionView class >> inviteLink [
	<preference: 'Redaw invite link'
		category: 'Redaw'
		description: 'The session the XR menu''s Apps > Redaw > Open joins. Kept with its doc, room and signal only: other parameters an invite link may carry, an LLM key say, would end up in the image, which is shared.'
		type: #String>
	^ InviteLink ifNil: ['']
]

{
	#category : #preferences,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:31'
}
SRRedawSessionView class >> inviteLink: aString [
	InviteLink := (aString isNil or: [aString withBlanksTrimmed isEmpty])
		ifTrue: [nil]
		ifFalse: [self sessionLinkFrom: aString]
]

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:31'
}
SRRedawSessionView class >> link: aString [
	"Join the session of an invite link and show it; a session already running for it is shared."
	| wanted |
	wanted := self sessionLinkFrom: aString.
	^ self on: (RedawSession allInstances
		detect: [:each | each isRunning and: [([self sessionLinkFrom: each peer link] on: Error do: [:e | nil]) = wanted]]
		ifNone: [RedawSession link: wanted])
]

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView class >> on: aRedawSession [
	^ self new session: aRedawSession; yourself
]

{
	#category : #'xr menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView class >> openIn: aWorld [
	"The last session's canvas on the floor ahead, with its controls; if it is open here already, both brought ahead."
	| view |
	view := (self in: aWorld)
		ifNil: [aWorld addChild: (self link: self inviteLink)]
		ifNotNil: [:open | open].
	view layOnFloor.
	view openTransport.
	^ view
]

{
	#category : #preferences,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:31'
}
SRRedawSessionView class >> sessionLinkFrom: aString [
	"The invite link with only what joining needs: doc, room and signal."
	| text hash base keep |
	text := aString withBlanksTrimmed.
	hash := text indexOf: $#.
	base := hash = 0 ifTrue: [''] ifFalse: [text copyFrom: 1 to: hash - 1].
	keep := ((text copyFrom: hash + 1 to: text size) subStrings: '&')
		select: [:each | #('doc=' 'room=' 'signal=') anySatisfy: [:key | each beginsWith: key]].
	keep size = 3 ifFalse: [^ self error: 'an invite link needs doc, room and signal'].
	^ String streamContents: [:s |
		s nextPutAll: base; nextPut: $#.
		keep do: [:each | s nextPutAll: each] separatedBy: [s nextPut: $&]]
]

{
	#category : #'xr menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:31'
}
SRRedawSessionView class >> switchTo: aLink in: aWorld [
	(self in: aWorld) ifNotNil: [:open |
		([self sessionLinkFrom: open session peer link] on: Error do: [:e | nil]) = aLink
			ifFalse: [open close]].
	^ self openIn: aWorld
]

{
	#category : #'xr menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView class >> xrMenuClose: aMenu [
	<xrMenu: #(world apps redaw) label: 'Close' priority: 30>
	(self in: aMenu world) ifNotNil: [:view | view close]
]

{
	#category : #'xr menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView class >> xrMenuControls: aMenu [
	<xrMenu: #(world apps redaw) label: 'Controls (play, stop, tour)' priority: 15>
	^ (self in: aMenu world) ifNotNil: [:view | view openTransport]
]

{
	#category : #'xr menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:31'
}
SRRedawSessionView class >> xrMenuOpen: aMenu [
	<xrMenu: #(world apps redaw) label: #xrMenuOpenLabel: priority: 10>
	self inviteLink isEmpty ifTrue: [^ self askForInviteLinkThenOpenIn: aMenu world].
	^ self openIn: aMenu world
]

{
	#category : #'xr menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:31'
}
SRRedawSessionView class >> xrMenuOpenLabel: aMenu [
	self inviteLink isEmpty ifTrue: [^ 'Open (asks for an invite link)'].
	(self in: aMenu world) ifNotNil: [^ 'Bring here'].
	^ 'Open ', (self hostOf: self inviteLink)
]

{
	#category : #'xr menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:31'
}
SRRedawSessionView class >> xrMenuOtherLink: aMenu [
	<xrMenu: #(world apps redaw) label: 'Other invite link...' priority: 20>
	^ self askForInviteLinkThenOpenIn: aMenu world
]

{
	#category : #'app menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView >> addCustomMenuItemsTo: aMenu [
	"Changes to my children wait for the next frame: menu actions run inside the input traversal."
	aMenu
		addItem: [self isPlaying ifTrue: ['Stop'] ifFalse: ['Play']]
		action: [self togglePlay]
		keepOpen: true.
	aMenu addItem: 'Next tour stop' action: [self nextTourStop] keepOpen: true.
	aMenu addItem: 'Controls' action: [self openTransportBeside: aMenu] keepOpen: false.
	aMenu addItem: 'Lay canvas here' action: [self layOnFloor] keepOpen: false.
	aMenu addSubmenuItemFor: #show filledBy: [:sub | self addFeatureItemsTo: sub].
	aMenu addItem: 'Close' action: [self world ifNotNil: [:w | w addDeferredFrameMessage: [self close]]] keepOpen: false
]

{
	#category : #'app menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:50'
}
SRRedawSessionView >> addFeatureItemsTo: aMenu [
	"The toggle waits for the next frame, and the menu reads its labels right after the action: read them again once it has run."
	self defaultFeatures do: [:each |
		aMenu
			addItem: [((self isEnabled: each) ifTrue: ['[x] '] ifFalse: ['[ ] ']), each menuLabel]
			action: [self world ifNotNil: [:w | w addDeferredFrameMessage: [
				self toggle: each.
				aMenu labelsChanged]]]
			keepOpen: true]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> blockHeight [
	^ blockHeight
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> blockHeight: aNumber [
	blockHeight := aNumber.
	pageBounds := nil
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> canvasExtent [
	"In metres."
	^ pageBounds extent * metersPerPixel
]

{
	#category : #'page layout',
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> clipHeight [
	"CLIP_HEIGHT in clips.js, in page pixels."
	^ 10
]

{
	#category : #opening,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView >> close [
	"Leaves the session too, unless another canvas shows it."
	transport ifNotNil: [transport remove. transport := nil].
	features copy do: [:each | self disable: each class].
	(self class allInstances anySatisfy: [:each | each ~~ self and: [each session == session and: [each world notNil]]])
		ifFalse: [session ifNotNil: [session close]].
	self remove
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:22'
}
SRRedawSessionView >> computePageBounds [
	| rects |
	rects := (features collect: [:each | each boundsOnCanvas]) reject: [:each | each isNil].
	^ (rects isEmpty
		ifTrue: [0 @ 0 extent: 500 @ 250]
		ifFalse: [rects allButFirst inject: rects first into: [:a :b | a merge: b]])
			expandBy: self margin
]

{
	#category : #features,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:22'
}
SRRedawSessionView >> defaultFeatures [
	^ {SRRedawClipsFeature. SRRedawNotesFeature. SRRedawLayersFeature. SRRedawCodeChangesFeature. SRRedawPlayheadFeature. SRRedawAudioFeature}
]

{
	#category : #features,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:04'
}
SRRedawSessionView >> disable: aFeatureClass [
	(self featureOf: aFeatureClass) ifNotNil: [:feature |
		features remove: feature.
		[feature deactivate] on: Error do: [:e | e return: nil].
		self removeChild: feature.
		pageBounds := nil]
]

{
	#category : #features,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> enable: aFeatureClass [
	| feature |
	(self featureOf: aFeatureClass) ifNotNil: [:existing | ^ existing].
	feature := aFeatureClass on: self.
	features add: feature.
	self addChild: feature.
	pageBounds := nil.
	^ feature
]

{
	#category : #features,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> featureOf: aFeatureClass [
	^ features detect: [:each | each class == aFeatureClass] ifNone: [nil]
]

{
	#category : #features,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> features [
	^ features
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> initialize [
	super initialize.
	metersPerPixel := 2 / 1000.
	blockHeight := 3cm.
	features := OrderedCollection new.
	plane := SRCube new
		drawWires: false;
		color: (Color gray: 0.22);
		yourself.
	self addChild: plane.
	self defaultFeatures do: [:each | self enable: each]
]

{
	#category : #'app menu',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView >> isApp [
	^ true
]

{
	#category : #features,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> isEnabled: aFeatureClass [
	^ (self featureOf: aFeatureClass) notNil
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:05'
}
SRRedawSessionView >> isLaidOut [
	^ pageBounds notNil
]

{
	#category : #transport,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView >> isPlaying [
	^ (self featureOf: SRRedawPlayheadFeature) ifNil: [false] ifNotNil: [:playhead | playhead isPlaying]
]

{
	#category : #opening,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:19'
}
SRRedawSessionView >> layOnFloor [
	"Flat on the floor ahead of the camera, its near edge half a metre away, the page's top pointing the way the camera looks."
	| camera forward yaw ahead |
	self isLaidOut ifFalse: [self step: 0].
	camera := self world camera.
	forward := camera forward.
	yaw := (forward x negated arcTan: forward z negated) radiansToDegrees.
	ahead := (Vector3 x: forward x y: 0 z: forward z) normalize.
	self rotation: (Quaternion angle: -90 axis: Vector3 right) * (Quaternion angle: yaw axis: Vector3 up).
	self translation: (camera globalTranslation x @ 1cm @ camera globalTranslation z) + (ahead * (50cm + (self canvasExtent y / 2)))
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> layoutPlane [
	plane
		scale: (self canvasExtent x) @ (self canvasExtent y) @ 1cm;
		translation: 0 @ 0 @ -0.5cm
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> localPointFor: aPagePoint [
	"The canvas is a plane in my XY plane facing +z, centred on my origin; page y goes down, so it maps to -y."
	| center |
	center := pageBounds center.
	^ ((aPagePoint x - center x) * metersPerPixel) @ ((center y - aPagePoint y) * metersPerPixel) @ 0
]

{
	#category : #'page layout',
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> margin [
	^ 40
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> metersPerPixel [
	^ metersPerPixel
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> metersPerPixel: aNumber [
	metersPerPixel := aNumber.
	pageBounds := nil
]

{
	#category : #transport,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView >> nextTourStop [
	"The cue to the next tour note after it, around to the first after the last, as the page's Tour pill."
	| playhead stops |
	playhead := (self featureOf: SRRedawPlayheadFeature) ifNil: [^ self].
	stops := (((self featureOf: SRRedawNotesFeature) ifNil: [#()] ifNotNil: [:notes | notes tour ifNil: [#()]])
		collect: [:each | each at: 't' ifAbsent: [nil]]) reject: [:each | each isNil].
	stops isEmpty ifTrue: [^ self].
	stops := stops asSet asSortedCollection.
	playhead seek: (stops detect: [:t | t > (playhead cue + 0.01)] ifNone: [stops first])
]

{
	#category : #opening,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 15:19'
}
SRRedawSessionView >> openInFront [
	self openInWorld.
	self layOnFloor
]

{
	#category : #transport,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView >> openTransport [
	^ self transport placeInFrontOf: self world camera; yourself
]

{
	#category : #transport,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView >> openTransportBeside: aMenu [
	"Read the menu's place now: the action runs before the menu closes."
	^ self transport
		placeAt: aMenu globalTranslation + (aMenu right * 45cm) facing: self world camera;
		yourself
]

{
	#category : #'page layout',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> pagePointAt: seconds y: worldY [
	^ (seconds * self pixelsPerSecond) @ worldY
]

{
	#category : #layout,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:40'
}
SRRedawSessionView >> pagePointFor: aLocalPoint [
	| center |
	center := pageBounds center.
	^ (aLocalPoint x / metersPerPixel + center x) @ (center y - (aLocalPoint y / metersPerPixel))
]

{
	#category : #'page layout',
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> pixelsPerSecond [
	"The page's default zoom (view.js), which fixes the aspect between time and canvas y."
	^ 100
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'leo-MCPServer 11/19/2026 17:39'
}
SRRedawSessionView >> session [
	^ session
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> session: aRedawSession [
	session := aRedawSession.
	session isRunning ifFalse: [session start].
	features do: [:each | each invalidate].
	pageBounds := nil
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:24'
}
SRRedawSessionView >> step: deltaTime [
	| changed bounds |
	session ifNil: [^ self].
	changed := features select: [:each | each refresh].
	(changed isEmpty and: [pageBounds notNil]) ifTrue: [^ self].
	bounds := self computePageBounds.
	bounds = pageBounds ifFalse: [
		pageBounds := bounds.
		self layoutPlane.
		^ features do: [:each | each relayout]].
	changed do: [:each | each relayout]
]

{
	#category : #features,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 14:21'
}
SRRedawSessionView >> toggle: aFeatureClass [
	"Answer whether it is on now."
	(self isEnabled: aFeatureClass)
		ifTrue: [self disable: aFeatureClass. ^ false]
		ifFalse: [self enable: aFeatureClass. ^ true]
]

{
	#category : #transport,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView >> togglePlay [
	(self featureOf: SRRedawPlayheadFeature) ifNotNil: [:playhead | playhead toggle]
]

{
	#category : #transport,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:00'
}
SRRedawSessionView >> transport [
	"My controls, made on first use and kept in my world beside me."
	(transport isNil or: [transport world isNil]) ifTrue: [
		transport := SRRedawTransport for: self.
		self world addChild: transport].
	^ transport
]
