"
The layer stack as one XR pane: a slab per layer, front on top; the selected one opened up. Read only.
"
Class {
	#name : #SRRedawLayerStack,
	#superclass : #SRObject,
	#instVars : [
		'view',
		'layers',
		'selectedId',
		'functionShown',
		'height',
		'rows',
		'functionRow',
		'backing',
		'lastError'
	],
	#category : #'Redaw-XR',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #constants,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack class >> shownKeys [
	^ #('id' 'name' 'type' 'hue' 'func' 'funcUpdated' 'paramValues' 'model')
]

{
	#category : #menu,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> addCustomMenuItemsTo: aMenu [
	"The same menu as my canvas'."
	view ifNotNil: [view addCustomMenuItemsTo: aMenu]
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> addDetailsFor: aLayer at: yStart [
	| y source color |
	y := yStart - 0.3cm.
	color := self colorOf: aLayer selected: true.
	source := aLayer at: 'func' ifAbsent: [nil].
	(source ifNotNil: [self descriptionIn: source]) ifNotNil: [:desc |
		(self wrap: desc columns: 58) do: [:line |
			y := self text: line at: y x: 3.5cm scale: 1.35cm color: (Color gray: 0.92)]].
	y := y - 0.8cm.
	(self paramsOf: aLayer) do: [:param | y := self addParam: param at: y color: color].
	(aLayer at: 'model' ifAbsent: [nil]) ifNotNil: [:model |
		y := self text: 'model: ', (self filesOf: model) at: y x: 3.5cm scale: 1.5cm color: (Color gray: 0.92)].
	(aLayer keys asSortedCollection reject: [:key | self class shownKeys includes: key]) do: [:key |
		y := self text: key, ': ', (self show: (aLayer at: key)) at: y x: 3.5cm scale: 1.5cm color: (Color gray: 0.92)].
	source ifNotNil: [| top |
		top := y - 0.3cm.
		y := self text: (functionShown ifTrue: ['v Function   '] ifFalse: ['> Function   ']), (self timeOf: (aLayer at: 'funcUpdated' ifAbsent: [nil])) at: top x: 3.5cm scale: 1.8cm color: Color white.
		functionRow := {top + 0.5cm. y - 0.3cm}.
		functionShown ifTrue: [
			y := y - 0.4cm.
			(self codeLines: source columns: 84 max: 120) do: [:line |
				y := self text: line at: y x: 3.5cm scale: 0.95cm color: (Color r: 0.75 g: 0.88 b: 1.0)]]].
	self addChild: (SRCube new
		drawWires: false;
		ignoreCollision: true;
		color: color;
		scale: 0.6cm @ (yStart - y) @ 1cm;
		position: (self left + 2.2cm) @ (yStart + y / 2) @ (self depth / 2 + 5mm);
		yourself).
	^ y - 0.8cm
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> addParam: anArray at: y color: aColor [
	"anArray is {name. value. min. max}."
	| trackLeft trackLength fraction barY |
	trackLeft := self left + 15cm.
	trackLength := 20cm.
	barY := y - 1cm.
	fraction := [((anArray second - anArray third) / (anArray fourth - anArray third)) asFloat min: 1.0 max: 0.0] on: Error do: [:e | 0.0].
	self text: anArray first at: y x: 3.5cm scale: 1.6cm color: (Color gray: 0.75).
	self addChild: (SRCube new
		drawWires: false;
		ignoreCollision: true;
		color: (Color gray: 0.35);
		scale: trackLength @ 0.8cm @ 4mm;
		position: (trackLeft + (trackLength / 2)) @ barY @ (self depth / 2 + 2mm);
		yourself).
	fraction > 0 ifTrue: [
		self addChild: (SRCube new
			drawWires: false;
			ignoreCollision: true;
			color: aColor;
			scale: (trackLength * fraction) @ 1cm @ 6mm;
			position: (trackLeft + (trackLength * fraction / 2)) @ barY @ (self depth / 2 + 3mm);
			yourself)].
	self text: (self show: anArray second) at: y x: 37cm scale: 1.6cm color: Color white.
	^ y - 2.4cm
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> addSlabFor: aLayer at: y [
	| selected slabHeight z |
	selected := (self idOf: aLayer) = selectedId.
	slabHeight := 6.5cm.
	z := selected ifTrue: [3cm] ifFalse: [1.5cm].
	self addChild: (SRCube new
		drawWires: false;
		ignoreCollision: true;
		color: (self colorOf: aLayer selected: selected);
		scale: (self width - 3cm) @ slabHeight @ 2cm;
		position: 0 @ (y - (slabHeight / 2)) @ z;
		yourself).
	self text: (aLayer at: 'name' ifAbsent: ['?']) at: y - 0.9cm x: 3cm z: z + 1cm + 1mm scale: 2.4cm color: (Color gray: 0.05).
	self text: (self subtitleOf: aLayer) at: y - 4cm x: 3cm z: z + 1cm + 1mm scale: 1.5cm color: (Color gray: 0.25).
	rows add: {self idOf: aLayer. y. y - slabHeight}.
	^ y - slabHeight - 0.7cm
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> build [
	| y |
	self children copy do: [:each | self removeChild: each].
	rows := OrderedCollection new.
	functionRow := nil.
	backing := SRCube new
		drawWires: false;
		color: (Color gray: 0.16);
		ignoreCollision: true;
		yourself.
	self addChild: backing.
	y := self text: 'Layers     front ^' at: -1.5cm x: 2cm scale: 2.2cm color: Color white.
	y := y - 0.6cm.
	layers reverseDo: [:each |
		y := self addSlabFor: each at: y.
		(self idOf: each) = selectedId ifTrue: [y := self addDetailsFor: each at: y]].
	y := self text: 'back - data flows up' at: y - 0.2cm x: 2cm scale: 1.4cm color: (Color gray: 0.65).
	height := y negated + 1.5cm.
	backing
		scale: self width @ height @ self depth;
		position: 0 @ (height / -2) @ 0.
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> codeLines: aString columns: columns max: maxLines [
	| lines |
	lines := OrderedCollection new.
	aString lines do: [:each | | line |
		line := (self plain: each) copyReplaceAll: '	' with: '  '.
		[line size > columns] whileTrue: [
			lines add: (line first: columns).
			line := '    ', (line allButFirst: columns)].
		lines add: line].
	lines size > maxLines ifTrue: [lines := (lines first: maxLines) asOrderedCollection. lines add: '...'].
	^ lines
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> collisionGeometry [
	^ SRCollisionBox new
		center: (self globalTransform localPointToGlobal: 0 @ (height / -2) @ 0);
		halfExtents: (self width @ height @ 8cm) / 2;
		rotation: self globalRotation;
		object: self
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> colorOf: aLayer selected: aBoolean [
	^ Color h: (aLayer at: 'hue' ifAbsent: [260]) s: (aBoolean ifTrue: [0.45] ifFalse: [0.3]) v: (aBoolean ifTrue: [1.0] ifFalse: [0.9])
]

{
	#category : #dimensions,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> depth [
	^ 2cm
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> descriptionIn: aSource [
	"The first desc: string of a layer function is meta.desc."
	| index stream |
	index := aSource findString: 'desc: '''.
	index = 0 ifTrue: [^ nil].
	stream := ReadStream on: aSource from: index + 7 to: aSource size.
	^ String streamContents: [:s |
		[stream atEnd or: [stream peek = $']] whileFalse: [
			stream peek = $\ ifTrue: [stream next].
			stream atEnd ifFalse: [s nextPut: stream next]]]
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> filesOf: aModel [
	| files |
	files := (aModel at: 'files' ifAbsent: [#()]) select: [:each | each endsWith: '.onnx'].
	files isEmpty ifTrue: [files := aModel at: 'files' ifAbsent: [#()]].
	^ String streamContents: [:s | files do: [:each | s nextPutAll: each] separatedBy: [s nextPutAll: ', ']]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> height [
	^ height
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> idOf: aLayer [
	^ aLayer at: 'id' ifAbsent: [aLayer at: 'name' ifAbsent: ['?']]
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> initialize [
	super initialize.
	self name: 'Redaw layers'.
	layers := #().
	rows := #().
	functionShown := false.
	height := 10cm.
]

{
	#category : #menu,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> isApp [
	^ true
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> lastError [
	^ lastError
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> later: aBlock [
	"Children change between frames, not inside the input traversal."
	self world ifNotNil: [:w | w addDeferredFrameMessage: aBlock]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> layers: aCollection [
	| new |
	new := aCollection asArray.
	new = layers ifTrue: [^ self].
	layers := new.
	(layers anySatisfy: [:each | (self idOf: each) = selectedId]) ifFalse: [selectedId := nil].
	self rebuild.
]

{
	#category : #dimensions,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> left [
	^ self width / -2
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> number: aKey in: aString [
	| index |
	index := aString findString: aKey.
	index = 0 ifTrue: [^ nil].
	^ [Number readFrom: (aString copyFrom: index + aKey size to: aString size) withBlanksTrimmed] on: Error do: [:e | nil]
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> onButtonPress: anEvent [
	| local |
	anEvent button == #trigger ifFalse: [^ self].
	local := self globalTransform globalPointToLocal: anEvent point.
	(functionRow notNil and: [local y <= functionRow first and: [local y >= functionRow second]])
		ifTrue: [^ self later: [self toggleFunction]].
	rows do: [:row |
		(local y <= row second and: [local y >= row third])
			ifTrue: [^ self later: [self select: row first]]]
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> paramSpecsIn: aSource [
	"{name. min. max. default} per line of the params block; layer functions put one parameter on a line."
	| lines start specs |
	lines := aSource lines.
	start := lines findFirst: [:each | each withBlanksTrimmed beginsWith: 'params:'].
	start = 0 ifTrue: [^ #()].
	specs := OrderedCollection new.
	(lines allButFirst: start) do: [:line | | trimmed paramName rest |
		trimmed := line withBlanksTrimmed.
		(trimmed beginsWith: '}') ifTrue: [^ specs asArray].
		paramName := trimmed copyUpTo: $:.
		(paramName notEmpty and: [paramName allSatisfy: [:c | c isAlphaNumeric or: [c = $_]]]) ifTrue: [
			rest := trimmed copyFrom: (trimmed lastIndexOf: $') + 1 to: trimmed size.
			specs add: {paramName.
				(self number: 'min:' in: rest) ifNil: [0].
				(self number: 'max:' in: rest) ifNil: [1].
				(self number: 'default:' in: rest) ifNil: [0]}]].
	^ specs asArray
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> paramsOf: aLayer [
	"{name. value. min. max} for each parameter the layer function declares."
	| source values |
	source := aLayer at: 'func' ifAbsent: [^ #()].
	values := aLayer at: 'paramValues' ifAbsent: [Dictionary new].
	^ (self paramSpecsIn: source) collect: [:spec |
		{spec first. values at: spec first ifAbsent: [spec at: 4]. spec second. spec third}]
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> plain: aString [
	"Raylib's font has ASCII glyphs only."
	^ String streamContents: [:s |
		aString do: [:c |
			c asInteger < 128
				ifTrue: [s nextPut: ((c = Character tab or: [c = Character cr or: [c = Character lf]]) ifTrue: [Character space] ifFalse: [c])]
				ifFalse: [s nextPutAll: (SRRedawFeature asciiFor: c)]]]
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> rebuild [
	"Live session data is not under our control: a bad layer must not open a debugger in the render process."
	[self build] on: Error do: [:e | lastError := e]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> select: anId [
	selectedId := selectedId = anId ifTrue: [nil] ifFalse: [anId].
	functionShown := false.
	self rebuild.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> selectedId [
	^ selectedId
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> show: aJsonValue [
	aJsonValue isString ifTrue: [^ aJsonValue].
	aJsonValue isFloat ifTrue: [^ (aJsonValue printShowingMaxDecimalPlaces: 2)].
	^ [Json render: aJsonValue] on: Error do: [:e | aJsonValue printString]
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> subtitleOf: aLayer [
	| type |
	type := aLayer at: 'type' ifAbsent: ['?'].
	type = 'audio-in' ifTrue: [^ 'mic / file -> audio'].
	type = 'audio-out' ifTrue: [^ 'audio -> speakers'].
	type = 'latent' ifTrue: [^ 'latent clips'].
	type = 'operator' ifFalse: [^ type].
	(aLayer at: 'model' ifAbsent: [nil]) ifNotNil: [:model | | files |
		files := model at: 'files' ifAbsent: [#()].
		(files anySatisfy: [:each | each beginsWith: 'decode']) ifTrue: [^ 'latent -> audio - ', (self filesOf: model)].
		(files anySatisfy: [:each | each beginsWith: 'encode']) ifTrue: [^ 'audio -> latent - ', (self filesOf: model)].
		^ 'model - ', (self filesOf: model)].
	^ (aLayer includesKey: 'func')
		ifTrue: ['audio <-> latent - function']
		ifFalse: ['audio <-> latent - drop a model']
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> text: aString at: y x: x scale: aNumber color: aColor [
	^ self text: aString at: y x: x z: self depth / 2 + 1mm scale: aNumber color: aColor
]

{
	#category : #building,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> text: aString at: y x: x z: z scale: aNumber color: aColor [
	"Answer the y below the line. A text field's position is its top left."
	self addChild: (SRTextField new
		text: (self plain: aString);
		color: aColor;
		scale: aNumber asVector3;
		rotation: SRTextField uprightRotation;
		position: (self left + x) @ y @ z;
		yourself).
	^ y - (aNumber * 1.3)
]

{
	#category : #'reading layers',
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> timeOf: aMilliseconds [
	aMilliseconds isNumber ifFalse: [^ ''].
	^ [| time |
		time := (DateAndTime fromUnixTime: aMilliseconds // 1000) asLocal.
		time asDate printString, ' ', (time asTime print24 first: 5)] on: Error do: [:e | '']
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> toggleFunction [
	functionShown := functionShown not.
	self rebuild.
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> view: aSessionView [
	view := aSessionView
]

{
	#category : #input,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> wantsGrab [
	^ true
]

{
	#category : #dimensions,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> width [
	^ 50cm
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/23/2026 16:51'
}
SRRedawLayerStack >> wrap: aString columns: columns [
	| lines line |
	lines := OrderedCollection new.
	line := ''.
	((self plain: aString) subStrings: ' ') do: [:word |
		line isEmpty
			ifTrue: [line := word]
			ifFalse: [line size + 1 + word size > columns
				ifTrue: [lines add: line. line := word]
				ifFalse: [line := line, ' ', word]]].
	line isEmpty ifFalse: [lines add: line].
	^ lines
]
