"
A code change for the session document, made from the difference between the Tonel files in the repository and the image written as Git/s writes them. Its patch is in the page's format (create / edits); every edit replaces whole methods, so a Smalltalk reader can also apply it per method.
"
Class {
	#name : #RedawTonelChange,
	#superclass : #Object,
	#instVars : [
		'base',
		'new',
		'repositoryPath',
		'baseCommit'
	],
	#category : #'Redaw-Peer',
	#'squeak_changestamp' : '<historical>'
}

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange class >> apply: someEdits to: aString [
	"As the page applies a patch part: each old_str must occur exactly once."
	^ someEdits inject: aString into: [:text :edit | | at |
		at := text indexOfSubCollection: (edit at: 'old_str').
		self assert: at > 0.
		self assert: (text indexOfSubCollection: (edit at: 'old_str') startingAt: at + 1) = 0.
		(text copyFrom: 1 to: at - 1), (edit at: 'new_str'), (text copyFrom: at + (edit at: 'old_str') size to: text size)]
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange class >> chunksOf: aString [
	"The class definition, then one chunk per method; concatenated they give aString back."
	| starts marker chunks i |
	marker := String lf, '{', String lf, String tab, '#category'.
	starts := OrderedCollection with: 1.
	i := 1.
	[(i := aString indexOfSubCollection: marker startingAt: i) > 0] whileTrue: [
		starts add: i + 1.
		i := i + 1].
	chunks := OrderedCollection new.
	starts doWithIndex: [:start :n | | text |
		text := aString copyFrom: start to: (n < starts size ifTrue: [(starts at: n + 1) - 1] ifFalse: [aString size]).
		chunks add: (n = 1 ifTrue: [#definition] ifFalse: [self keyOf: text]) -> text].
	^ chunks
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange class >> editsFrom: anOldString to: aNewString [
	"One edit per changed method; added methods go with the chunk before them, which exists in both. Each old_str contains a method's header line or the class definition, so it is unique in the file."
	| old groups current |
	old := Dictionary new.
	(self chunksOf: anOldString) do: [:each | old at: each key put: each value].
	groups := OrderedCollection new.
	(self chunksOf: aNewString) do: [:each |
		(old includesKey: each key)
			ifTrue: [groups add: (current := {old at: each key. each value})]
			ifFalse: [current at: 2 put: (current at: 2), each value]].
	(self chunksOf: anOldString) do: [:each |
		((self chunksOf: aNewString) anySatisfy: [:n | n key = each key]) ifFalse: [groups add: {each value. ''}]].
	^ (groups reject: [:g | g first = g second]) collect: [:g |
		JsonObject new at: 'old_str' put: g first; at: 'new_str' put: g second; yourself]
]

{
	#category : #'instance creation',
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange class >> from: aBaseDirectory to: aNewDirectory [
	"Two Tonel package directories: the repository's, and the image's written by the same mapper."
	^ self new setBase: aBaseDirectory new: aNewDirectory
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange class >> keyOf: aMethodChunk [
	"The line naming the method, e.g. 'Foo class >> bar: x ['."
	| lines |
	lines := aMethodChunk lines.
	^ lines detect: [:each | each includesSubstring: ' >> '] ifNone: [aMethodChunk]
]

{
	#category : #text,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange class >> linesOf: aFileReference [
	"Git keeps the files with LF, a Windows checkout has CRLF."
	^ (aFileReference readStreamDo: [:s | s upToEnd]) withUnixLineEndings
]

{
	#category : #publishing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange class >> newId [
	"As the page's: eight base-36 characters."
	^ String new: 8 streamContents: [:s | 8 timesRepeat: [s nextPut: ('abcdefghijklmnopqrstuvwxyz0123456789' atRandom)]]
]

{
	#category : #publishing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange class >> publish: aChange to: aPeer [
	"Also records the author as having it, as the page does when it publishes."
	| id |
	id := aChange at: 'id'.
	aPeer at: 'code/changes/', id put: aChange.
	(aPeer jsonAt: 'code/incorporated') ifNil: [aPeer jsonAt: 'code/incorporated' put: '{}'].
	aPeer at: 'code/incorporated/', id put: (JsonObject new at: (aChange at: 'author') put: (aChange at: 'at'); yourself).
	^ id
]

{
	#category : #writing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange class >> writePackage: aPackageName into: aDirectory [
	"With the mapper Git/s uses, so that only real changes differ from the repository."
	| mapper |
	mapper := GSTonelMapper allInstances detect: [:each | each package name = aPackageName].
	aDirectory ensureCreateDirectory.
	mapper write: mapper workingCopySnapshot with: (mapper writerOn: aDirectory).
	^ aDirectory
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange >> baseCommit: aString [
	baseCommit := aString.
]

{
	#category : #publishing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange >> changeNamed: aName intent: anIntent author: anAuthor [
	"A change as the page publishes it, plus lang and base, which it does not know and ignores."
	^ JsonObject new
		at: 'id' put: self class newId;
		at: 'name' put: aName;
		at: 'intent' put: anIntent;
		at: 'author' put: anAuthor;
		at: 'at' put: DateAndTime now asUnixTime * 1000;
		at: 'deps' put: #();
		at: 'after' put: #();
		at: 'lang' put: 'smalltalk';
		at: 'base' put: (JsonObject new at: 'repository' put: 'latent-canvas'; at: 'commit' put: baseCommit; at: 'format' put: 'tonel'; yourself);
		at: 'patch' put: self patch;
		yourself
]

{
	#category : #patch,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange >> patch [
	"In the page's format: {path, create} for a new file, {path, edits} for a changed one."
	| parts |
	parts := OrderedCollection new.
	(new files asSortedCollection: [:a :b | a basename <= b basename]) do: [:file | | path old |
		path := repositoryPath, '/', file basename.
		old := base / file basename.
		old exists
			ifFalse: [parts add: (JsonObject new at: 'path' put: path; at: 'create' put: (self class linesOf: file); yourself)]
			ifTrue: [| edits |
				edits := self class editsFrom: (self class linesOf: old) to: (self class linesOf: file).
				edits isEmpty ifFalse: [parts add: (JsonObject new at: 'path' put: path; at: 'edits' put: edits asArray; yourself)]]].
	^ parts asArray
]

{
	#category : #patch,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange >> removedFiles [
	^ (base files reject: [:file | (new / file basename) exists]) collect: [:file | file basename]
]

{
	#category : #accessing,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange >> repositoryPath: aString [
	"Where the package lies in the repository; the patch paths start with it."
	repositoryPath := aString.
]

{
	#category : #initialization,
	#'squeak_changestamp' : 'jl-MCPServer 11/26/2026 12:10'
}
RedawTonelChange >> setBase: aBaseDirectory new: aNewDirectory [
	base := aBaseDirectory.
	new := aNewDirectory.
	repositoryPath := 'squeak/', aBaseDirectory basename.
]
