Class {
	#name : #SRRedawLatentPanel,
	#superclass : #SRObject,
	#instVars : [
		'canvas',
		'display',
		'widgets',
		'drag'
	],
	#category : #'Redaw-XR'
}

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel class >> for: aSessionView [
	^ self new setCanvas: aSessionView
]

{
	#category : #menus,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> addCustomMenuItemsTo: aMenu [
	canvas ifNotNil: [canvas addCustomMenuItemsTo: aMenu]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> canvas [
	^ canvas
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> choose: aSelector among: labelsAndValues [
	"One segment per value, lit while the style has it."
	^ SRRedawSegmentedControl
		width: self contentWidth
		options: (labelsAndValues collect: [:each | {
			each key.
			[self style notNil and: [(self style perform: aSelector) = each value]].
			[self style ifNotNil: [:style | style perform: aSelector asMutator with: each value]]}])
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> collisionGeometry [
	^ SRCollisionBox new
		center: self globalTranslation;
		halfExtents: self size / 2;
		rotation: self globalRotation;
		object: self
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> contentWidth [
	^ self size x - 4cm
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> facePointOn: aRay [
	"Where aRay meets the plane of my front face, global; nil if it runs along it or away from it."
	| toLocal origin direction t |
	toLocal := self globalTransform inverseTransformation.
	origin := toLocal localPointToGlobal: aRay origin.
	direction := toLocal localDirToGlobal: aRay forward.
	direction z abs < 1.0e-9 ifTrue: [^ nil].
	t := self size z / 2 - origin z / direction z.
	t < 0 ifTrue: [^ nil].
	^ self globalTransform localPointToGlobal: origin + (direction * t)
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> followDrag [
	"Runs every frame while the trigger is held: the slider follows where the ray meets my face."
	| hand |
	drag ifNil: [^ self].
	hand := drag value.
	hand trigger isPressed ifFalse: [^ drag := nil].
	(self facePointOn: hand cursor redawRay) ifNotNil: [:point | drag key trackAt: point].
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> initialize [
	| top front |
	super initialize.
	self name: 'Latent view'.
	top := self size y / 2.
	front := self size z / 2.
	self addChild: (SRCube new
		drawWires: false;
		color: (Color gray: 0.18);
		ignoreCollision: true;
		scale: self size;
		yourself).
	display := self addChild: (self textField: 'Latent view' scale: 1.4cm color: Color white).
	display position: (self contentWidth / -2) @ (top - 1.2cm) @ (front + 1mm).
	widgets := OrderedCollection new.
	self rows doWithIndex: [:row :i | | y |
		y := top - 4cm - (i - 1 * self rowHeight).
		(self addChild: (self textField: row key scale: 0.9cm color: (Color gray: 0.75)))
			position: (self contentWidth / -2) @ y @ (front + 1mm).
		widgets add: (self addChild: (row value
			grabTarget: self;
			translation: 0 @ (y - 1.4cm - (row value height / 2)) @ (front + 6mm);
			yourself))].
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> isApp [
	^ true
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> onButtonPress: anEvent [
	anEvent button == #trigger ifFalse: [^ self].
	widgets do: [:each |
		(each pressAt: anEvent point) ifNotNil: [:result |
			result == #drag ifTrue: [self startDrag: each hand: anEvent hand].
			^ self]].
]

{
	#category : #placing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> placeAt: aPosition facing: aCamera [
	| toward yaw |
	toward := aCamera globalTranslation - aPosition.
	yaw := (toward x arcTan: toward z) radiansToDegrees.
	self rotation: (Quaternion angle: yaw axis: Vector3 up).
	self translation: aPosition
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> rowHeight [
	^ 6cm
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> rows [
	"A one-line description and the control below it."
	| cm |
	^ {
		'Colour of each column' -> (self choose: #colourMode among: {'page' -> 0. 'vector' -> 1. 'page by size' -> 2. 'one dim' -> 3}).
		'Height of each column (stacked: fixed)' -> (self choose: #heightMode among: {'flat' -> 0. 'length' -> 1. 'movement' -> 2. 'dim size' -> 3. 'dim signed' -> 4}).
		'Where the values of a frame go' -> (self choose: #place among: {'top' -> 0. 'sides' -> 1. 'top + sides' -> 2. 'stacked' -> 3}).
		'How many dimensions are drawn' -> (self choose: #count among: (#(128 64 32 16 8 4) collect: [:each | each printString -> each])).
		'Which dimensions come first' -> (self choose: #ordered among: {'by index' -> false. 'by variance' -> true}).
		'Help to find one dimension' -> (self toggles: {'grid lines' -> #grid. 'mark the dimension' -> #highlight}).
		'The dimension shown, or marked' -> (self slide: #dim from: 0 to: [self style ifNil: [127] ifNotNil: [:style | style dims - 1]] print: [:value | 'dim ', value printString]) beInteger.
		'Contrast of the values (gain)' -> (self slide: #gain from: 0.05 to: 50 print: [:value | value printShowingDecimalPlaces: 2]) beLogarithmic.
		'Height of the columns' -> (self slide: #heightScale from: 5mm to: 2m print: [:value |
			cm := value * 100.
			(cm < 10 ifTrue: [cm printShowingDecimalPlaces: 1] ifFalse: [cm rounded printString]), ' cm']) beLogarithmic.
		'Gap between frames' -> (self slide: #gap from: 0 to: 0.6 print: [:value | (value * 100) rounded printString, ' %'])}
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> setCanvas: aSessionView [
	canvas := aSessionView.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> size [
	^ 50cm @ (10 * self rowHeight + 5cm) @ 3cm
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> slide: aSelector from: min to: max print: aBlock [
	^ SRRedawSlider
		width: self contentWidth
		from: min
		to: max
		get: [self style ifNil: [min] ifNotNil: [:style | style perform: aSelector]]
		set: [:value | self style ifNotNil: [:style | style perform: aSelector asMutator with: value]]
		print: aBlock
]

{
	#category : #events,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> startDrag: aSlider hand: aHand [
	((aHand isKindOf: SRHand) and: [aHand cursor respondsTo: #redawRay]) ifFalse: [^ self].
	drag := aSlider -> aHand.
]

{
	#category : #stepping,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> step: deltaTime [
	"Runs in the world process: an error here must not reach a debugger."
	[self followDrag.
	 widgets do: [:each | each refresh].
	 display text: (self style ifNil: ['Latent view: no clips feature'] ifNotNil: ['Latent view'])]
		on: Error do: [:e |
			drag := nil.
			display text: 'Latent view: ', e messageText].
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> style [
	^ canvas ifNotNil: [(canvas featureOf: SRRedawClipsFeature) ifNotNil: [:feature | feature style]]
]

{
	#category : #'initialize-release',
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> textField: aString scale: aNumber color: aColor [
	^ SRTextField new
		text: aString;
		color: aColor;
		scale: aNumber asVector3;
		rotation: SRTextField uprightRotation;
		yourself
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 15:25'
}
SRRedawLatentPanel >> toggles: labelsAndSelectors [
	^ SRRedawSegmentedControl
		width: self contentWidth
		options: (labelsAndSelectors collect: [:each | {
			each key.
			[self style notNil and: [self style perform: each value]].
			[self style ifNotNil: [:style | style perform: each value asMutator with: (style perform: each value) not]]}])
]

{
	#category : #testing,
	#'squeak_changestamp' : 'jl-MCPServer 11/25/2026 11:32'
}
SRRedawLatentPanel >> wantsGrab [
	^ true
]
