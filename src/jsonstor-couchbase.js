'use strict';

const jsongin = require( '@liquicode/jsongin' );


//---------------------------------------------------------------------
// ***There is no driver, and this one was decided by a stopwatch.***
//
// Couchbase is the first target here where the two paths are not the same wire. CouchDB and
// Elasticsearch speak HTTP and nothing else, so `fetch` was the whole story; Couchbase has a
// ***key/value data service on 11210 which `fetch` cannot reach at all***, and a query service
// on 8093 which it reaches perfectly. So the question was never whether the driver works but
// what the KV path buys, and that had to be a number.
//
// Capability is a tie - every operation this interface needs works on both paths, the duplicate
// key refusal included. The SDK is about ***5 ms faster per by-key round trip*** and identical
// on everything else, for 74 MB and a native addon. Its one structural advantage, `at_plus`,
// was measured worth ***nothing***: it costs 199.90 ms against `request_plus`'s 200.27, because
// `indexer.settings.inmemory_snapshot.interval` is 200 and no client can beat the next snapshot.
//
// See jsonx/.plans/wave-5-query-languages.md.


//---------------------------------------------------------------------
// ***A bucket is not a collection, and this is the one adapter where that had to be argued.***
//
// `jsonstor-couchdb` makes a database a collection and `jsonstor-elasticsearch` makes an index
// one, because both are cheap to create and drop. ***A Couchbase bucket is neither.*** It is
// allocated a RAM quota, it is created by a cluster administrator over a management port this
// adapter does not open, and Community Edition caps how many a cluster may have. A library which
// spent a bucket per collection would run a cluster out of collections at ten.
//
// ***And Couchbase's own collections cannot be it either***, because they arrived in 7.0 and
// this package's floor is 5.0 - measured, see the bottom of this file. Building on them would
// raise the floor by two majors to buy a container the key range below already gives.
//
// ***So a bucket is the container and a collection is a key range inside it***, which is
// `jsonstor-redis`'s answer for the same reason and `jsonstor-leveldb`'s construction exactly:
// every key begins `<CollectionName>::`, and the range ends at the next byte up.
//
//     BucketName:     'testdb'          the bucket, which somebody else created
//     CollectionName: 'my-documents'    the key range inside it, which this storage owns
//
//     key             'my-documents::42'
//     range           [ 'my-documents::', 'my-documents:;' )
//
// ***A range and not a `LIKE`, and that is a measurement.*** The obvious rendering is
// `META().id LIKE "name::%"`, and it was measured ***returning a neighbour's documents***: a
// collection named `a%b` matches the key `axxb::1`, because `%` is a `LIKE` metacharacter. The
// range compares whole strings and has no metacharacters to escape.
//
// ***A colon in a collection name is refused***, which is what makes the range exact rather than
// nearly exact. Without that rule a collection named `aa:` writes `aa:::1`, which sorts inside
// `aa`'s range - so `aa` would read `aa:`'s documents. `jsonstor-leveldb` forbids both of its
// bounding bytes for the same reason and checks rather than assumes.


//---------------------------------------------------------------------
// ***The document is stored at the top level, and it cannot be otherwise.***
//
// This is the exact mirror of `jsonstor-elasticsearch`, which cannot avoid a payload because
// Elasticsearch reserves `_id`. ***Here a payload is impossible***: `N1qlExpression` renders a
// criteria into a WHERE clause naming the document's own paths, and the clause is an opaque
// string this adapter cannot rewrite. A payload would need every path in it prefixed, and there
// is nothing to prefix - which is the same fact from the other side as N1QL having no columns.
//
// ***So the document goes in whole - and then a second time, as text.***
//
//     key      'my-documents::42'                        the collection and the identifier
//     value    { ...the document as a map...,            what the WHERE clause reads
//                jsonstor_sequence: '00001756...',       insertion order
//                jsonstor_document: '{"zeta":1,...}' }   verbatim, what a read returns
//
// ***Couchbase sorts an object's fields alphabetically***, at the top level, nested, and inside
// an array - measured on 2026-09-05, sending `{ zeta, alpha, nested: { yankee, bravo } }` and
// getting `{ alpha, nested: { bravo, yankee }, zeta }` back. ***jsongin's object equality is
// order sensitive***, so a document stored as a map alone does not come back equal to itself:
// `{ nested: <as sent> }` was measured ***not*** matching the document it had just been written
// from. That is six failures in the shared inventory and a wrong answer rather than a slow one.
//
// ***So the map is what the pushdown filters and a JSON string is what a read answers with***,
// because nothing can reorder a string. ***This is `jsonstor-dynamodb`'s layout, reached
// independently from the same cause*** - a map which does not keep field order - and it is worth
// naming as a pattern rather than a coincidence: two of the family's five translating adapters
// need two copies, and both discovered it the same way.
//
//   ***What it costs is size, and here that is all it costs.*** DynamoDB pays this against a
//   400KB item cap, so its largest storable document is much smaller than the cap suggests. A
//   Couchbase document may be 20MB, so doubling is a storage bill rather than a ceiling.
//
// ***The two reserved names are `jsonstor_sequence` and `jsonstor_document`***, and this adapter
// is the family's most exposed to that: a caller's own field of either name is overwritten on
// write and removed on read. Every other adapter here either has a payload to hide its
// bookkeeping in or a medium which carries it out of band.
//
// ***Couchbase does coerce nothing***, which is the half of the fidelity claim that survived
// measurement: a round trip returns every value with its type intact, and an absent field stays
// apart from one holding null. That is why so much of `N1qlExpression` is exact, and why
// `Residual: null` - which no other translating adapter here sees often - is the common case.


//---------------------------------------------------------------------
// ***Every statement whose predicate resolves through the index asks for `request_plus`.***
//
// The query service reads a secondary index the data service updates asynchronously, so the
// default `not_bounded` answers from whatever the index happens to hold. ***The operator probe's
// first run inserted four documents, read back none, and produced a table of thirty one false
// defects.*** Every suite in this family writes and reads in the same breath.
//
// ***And it is not a rule about reading.*** The driver probe's own teardown ran a `DELETE ...
// WHERE` without it and left 137 documents behind, because a DELETE names its rows through the
// same index a SELECT reads. So `n1ql()` defaults to `request_plus` and the by-key paths opt out
// by name - the safe value is the one you get by forgetting.


module.exports = {

	AdapterName: 'jsonstor-couchbase',
	AdapterDescription: 'Documents are stored in a Couchbase bucket.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		/*
			Settings = {
				Server: '',              // The name or address of the server.
				Port: 8093,              // The query service port.
				Encrypt: false,          // Whether to reach the query service over https.
				BucketName: '',          // The bucket holding this collection.
				CollectionName: '',      // The key range within it which is this collection.
				UserName: '',            // The user to connect as. Empty for none.
				Password: '',            // That user's password. Empty for none.
				PrimaryKey: '_id',       // The field which is the identifier.
			}
		*/
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		if ( jsongin.ShortType( Settings.Server ) !== 's' ) { throw new Error( `This adapter requires a Settings.Server string parameter.` ); }
		if ( jsongin.ShortType( Settings.BucketName ) !== 's' ) { throw new Error( `This adapter requires a Settings.BucketName string parameter.` ); }
		if ( !Settings.BucketName.length ) { throw new Error( `Settings.BucketName cannot be empty.` ); }
		if ( jsongin.ShortType( Settings.CollectionName ) !== 's' ) { throw new Error( `This adapter requires a Settings.CollectionName string parameter.` ); }
		if ( !Settings.CollectionName.length ) { throw new Error( `Settings.CollectionName cannot be empty.` ); }


		//=====================================================================
		const SEQUENCE_FIELD = 'jsonstor_sequence';
		const PAYLOAD_FIELD = 'jsonstor_document';
		const RESERVED_FIELDS = [ SEQUENCE_FIELD, PAYLOAD_FIELD ];
		const REQUEST_TIMEOUT_MS = 30000;
		const WRITE_BATCH_SIZE = 100;

		// ***The separator and the byte above it.*** A collection is the key range
		// [ name + SEPARATOR, name + TERMINATOR ), which is `jsonstor-leveldb`'s construction in
		// characters a Couchbase key may legibly carry. `;` is `:` plus one, which is why the
		// terminator is what it is rather than something arbitrary.
		const KEY_SEPARATOR = '::';
		const KEY_TERMINATOR = ':;';

		// ***The keyspace alias, and it is not `d`.*** An unqualified identifier in a WHERE
		// clause resolves to the keyspace alias before it resolves to a field, so a one letter
		// alias would make a criteria about a field named `d` compare the whole document.
		// `N1qlExpression` already reserves `jsonstor_v` for its array element variable; this is
		// the same namespace, and a collision needs a caller to have a field called
		// `jsonstor_d`.
		const KEYSPACE_ALIAS = 'jsonstor_d';

		// The two shapes a Couchbase server reports an existing primary index with. ***4300 is
		// 8.0's and 5000 is 5.0's***, measured against both on 2026-09-05 - so an adapter which
		// recognized one of them would create indexes on one version and fail on the other.
		const INDEX_EXISTS_CODES = [ 4300, 5000 ];

		// ***A duplicate key is code 12009 and 12009 is not only a duplicate key.*** It is
		// `DML Error`, which also covers a CAS mismatch, so the code alone would rename a
		// concurrency failure. ***And the message is not the same on both versions*** - 8.0 says
		// `Duplicate Key: k` and 5.0 says `Duplicate Key k` - so the text alone would recognize
		// one server and not the other. Both together is the only thing which is right on both.
		const DML_ERROR_CODE = 12009;
		const DUPLICATE_KEY_TEXT = 'duplicate key';


		//=====================================================================
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = jsongin.Clone( Settings );
		if ( jsongin.ShortType( Storage.Settings.Port ) !== 'n' ) { Storage.Settings.Port = 8093; }
		if ( jsongin.ShortType( Storage.Settings.Encrypt ) !== 'b' ) { Storage.Settings.Encrypt = false; }
		if ( jsongin.ShortType( Storage.Settings.UserName ) !== 's' ) { Storage.Settings.UserName = ''; }
		if ( jsongin.ShortType( Storage.Settings.Password ) !== 's' ) { Storage.Settings.Password = ''; }

		// See the note at the top of this file: a colon in a collection name would put one
		// collection's keys inside another's range.
		if ( Storage.Settings.CollectionName.indexOf( ':' ) >= 0 )
		{
			throw new Error( `Settings.CollectionName cannot contain a colon; it separates the collection from the document key.` );
		}
		// An identifier goes between backticks, and there is no escape for one inside.
		if ( Storage.Settings.BucketName.indexOf( '`' ) >= 0 )
		{
			throw new Error( `Settings.BucketName cannot contain a backtick.` );
		}

		// ***PrimaryKey names the identifier and IdField is the deprecated alias.***
		let key_declaration = jsonstor.PrimaryKey.Resolve( Storage.Settings );
		if ( key_declaration.Fields.length > 1 )
		{
			throw new Error( `This adapter does not support a composite PrimaryKey: [${key_declaration.Fields.join( ', ' )}].` );
		}
		Storage.Settings.IdField = key_declaration.Fields.length ? key_declaration.Fields[ 0 ] : '_id';
		Storage.PrimaryKeyInfo = {
			Fields: [ Storage.Settings.IdField ],
			// The document key is a string, and - unlike CouchDB and Elasticsearch - the
			// document beside it keeps the identifier's own type, because nothing here reserves
			// the field name.
			Types: [ 's' ],
			Mutable: ( key_declaration.Mutable === true ),
			Generated: true,
			// ***The identifier index is the server's own.*** A document key is unique in a
			// bucket and `INSERT` refuses a second one, which is what this claim promises.
			IndexHostedBy: 'database',
		};


		//=====================================================================
		// The transport.
		//=====================================================================


		//---------------------------------------------------------------------
		function base_url()
		{
			let scheme = Storage.Settings.Encrypt ? 'https' : 'http';
			return `${scheme}://${Storage.Settings.Server}:${Storage.Settings.Port}`;
		}


		//---------------------------------------------------------------------
		function authorization_header()
		{
			if ( !Storage.Settings.UserName.length ) { return ''; }
			let credential = `${Storage.Settings.UserName}:${Storage.Settings.Password}`;
			return 'Basic ' + Buffer.from( credential ).toString( 'base64' );
		}


		//---------------------------------------------------------------------
		// ***One statement, and the error is returned rather than thrown on.***
		//
		// Several outcomes are answers rather than failures - an existing primary index, a
		// duplicate key - so the caller decides what an error means. A server which cannot be
		// reached at all still throws, out of `fetch`, which is what
		// `004) Unreachable Storage Tests` requires of every read.
		//
		// ***`request_plus` is the default because forgetting it is the failure mode.*** See the
		// note at the top of this file.
		async function n1ql( Statement, Consistency )
		{
			let options = {
				method: 'POST',
				headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
				body: JSON.stringify( {
					statement: Statement,
					scan_consistency: Consistency || 'request_plus',
				} ),
				signal: AbortSignal.timeout( REQUEST_TIMEOUT_MS ),
			};
			let authorization = authorization_header();
			if ( authorization.length ) { options.headers.Authorization = authorization; }
			let response = await fetch( `${base_url()}/query/service`, options );
			let text = await response.text();
			let parsed = null;
			if ( text.length )
			{
				try { parsed = JSON.parse( text ); }
				catch ( error ) { parsed = null; }
			}
			if ( parsed && ( parsed.status === 'success' ) )
			{
				return { Rows: Array.isArray( parsed.results ) ? parsed.results : [], Error: null };
			}
			let first = ( parsed && Array.isArray( parsed.errors ) && parsed.errors[ 0 ] ) ? parsed.errors[ 0 ] : null;
			let failure = {
				Code: first ? Number( first.code ) : 0,
				Message: first ? String( first.msg || '' ) : text.slice( 0, 200 ),
				Status: response.status,
			};
			return { Rows: [], Error: failure };
		}


		//---------------------------------------------------------------------
		// ***Couchbase says why, and the message keeps it.*** An error carries a code and a
		// message, and a message reporting only the status would throw away the half which says
		// what to do about it.
		function n1ql_error( What, Failure )
		{
			return new Error( `The Couchbase server refused a ${What}: [${Failure.Code}] ${Failure.Message}` );
		}


		//---------------------------------------------------------------------
		// Runs a statement whose only acceptable outcome is success.
		async function run( What, Statement, Consistency )
		{
			let answer = await n1ql( Statement, Consistency );
			if ( answer.Error ) { throw n1ql_error( What, answer.Error ); }
			return answer.Rows;
		}


		//---------------------------------------------------------------------
		function is_duplicate_key( Failure )
		{
			if ( !Failure ) { return false; }
			if ( Failure.Code !== DML_ERROR_CODE ) { return false; }
			return Failure.Message.toLowerCase().indexOf( DUPLICATE_KEY_TEXT ) >= 0;
		}


		//=====================================================================
		// The keyspace.
		//=====================================================================


		//---------------------------------------------------------------------
		function bucket_reference()
		{
			return '`' + Storage.Settings.BucketName + '`';
		}


		//---------------------------------------------------------------------
		function keyspace()
		{
			return `${bucket_reference()} ${KEYSPACE_ALIAS}`;
		}


		//---------------------------------------------------------------------
		// ***The clause which says "this collection and no neighbour".*** Every statement which
		// resolves through the index carries it.
		function collection_range()
		{
			let low = JSON.stringify( Storage.Settings.CollectionName + KEY_SEPARATOR );
			let high = JSON.stringify( Storage.Settings.CollectionName + KEY_TERMINATOR );
			return `(META(${KEYSPACE_ALIAS}).id >= ${low} AND META(${KEYSPACE_ALIAS}).id < ${high})`;
		}


		//---------------------------------------------------------------------
		function document_key( Key )
		{
			return Storage.Settings.CollectionName + KEY_SEPARATOR + Key;
		}


		//=====================================================================
		// The primary index.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***The query service refuses an unindexed keyspace rather than scanning it***, which
		// is a class of failure no other adapter in this family has: without a primary index on
		// the bucket, every criteria query answers `No index available`.
		//
		// ***So it is created on the first write and never on a read***, the same rule
		// `jsonstor-elasticsearch` creates its index by. A read against a bucket nobody has
		// written to is an empty collection, and creating an index to answer a `Count()` would
		// make a question change the thing it asks about.
		//
		// ***An index which is already there is the answer this asked for***, and recognizing
		// that takes two codes rather than one - see INDEX_EXISTS_CODES.
		//
		// ***Only a success is remembered.*** A failure cached here would answer for the life of
		// the process, and the failure it would cache is an unreachable server.
		let index_ready = false;
		async function ensure_index()
		{
			if ( index_ready ) { return; }
			let answer = await n1ql( `CREATE PRIMARY INDEX ON ${bucket_reference()}` );
			if ( !answer.Error ) { index_ready = true; return; }
			if ( INDEX_EXISTS_CODES.indexOf( answer.Error.Code ) >= 0 )
			{
				index_ready = true;
				return;
			}
			throw n1ql_error( 'primary index create', answer.Error );
		}


		//=====================================================================
		// The document layout.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***The value which goes in the key.*** The document is where the identifier keeps its
		// own type; the key holds `String()` of it so the by-id paths compare like with like.
		function id_to_key( Document )
		{
			let value = Document[ Storage.Settings.IdField ];
			if ( ( value === null ) || ( typeof value === 'undefined' ) ) { return null; }
			return '' + value;
		}


		//---------------------------------------------------------------------
		// The key a write uses, refusing by name the one document which has none.
		function required_key( Document )
		{
			let key = id_to_key( Document );
			if ( key === null )
			{
				throw new Error( `Cannot store a document whose [${Storage.Settings.IdField}] is null; a Couchbase document key cannot be empty.` );
			}
			return document_key( key );
		}


		//---------------------------------------------------------------------
		// ***The document as Couchbase is given it: the map to filter, and the text to answer
		// with.***
		//
		// See the note at the top of this file. The map is what the pushdown reads and it is the
		// copy Couchbase is free to reorder; the string is what a read returns, and nothing can
		// reorder a string.
		function document_to_value( Document, Sequence )
		{
			let value = jsongin.Clone( Document );
			if ( typeof Sequence === 'string' ) { value[ SEQUENCE_FIELD ] = Sequence; }
			value[ PAYLOAD_FIELD ] = JSON.stringify( Document );
			return value;
		}


		//---------------------------------------------------------------------
		// ***The document as the caller gets it back, which is the verbatim copy.***
		//
		// ***The fallback is for a document this adapter did not write.*** A bucket is shared,
		// and a key which lands in this collection's range without a payload beside it is
		// somebody else's - answering with the map is the best that can be done for it, and
		// better than answering with nothing.
		function value_to_document( Value )
		{
			if ( jsongin.ShortType( Value ) !== 'o' ) { return {}; }
			if ( typeof Value[ PAYLOAD_FIELD ] === 'string' )
			{
				try { return JSON.parse( Value[ PAYLOAD_FIELD ] ); }
				catch ( error ) { /* Fall through and answer with the map. */ }
			}
			let document = {};
			let names = Object.keys( Value );
			for ( let index = 0; index < names.length; index++ )
			{
				if ( RESERVED_FIELDS.indexOf( names[ index ] ) >= 0 ) { continue; }
				document[ names[ index ] ] = jsongin.Clone( Value[ names[ index ] ] );
			}
			return document;
		}


		//---------------------------------------------------------------------
		// ***A counter which makes a sequence unique inside one process.*** The same shape
		// `jsonstor-couchdb`, `jsonstor-redis`, `jsonstor-leveldb` and `jsonstor-elasticsearch`
		// use, padded to fixed widths because a variable width field sorts differently than it
		// was written.
		let key_sequence = 0;
		function new_sequence()
		{
			let hr_time = process.hrtime();
			let milliseconds = String( ( new Date() ).getTime() ).padStart( 14, '0' );
			let hr_seconds = String( hr_time[ 0 ] ).padStart( 10, '0' );
			let hr_nanoseconds = String( hr_time[ 1 ] ).padStart( 9, '0' );
			key_sequence = ( key_sequence + 1 ) % 1000000;
			let sequence = String( key_sequence ).padStart( 6, '0' );
			return `${milliseconds}.${hr_seconds}.${hr_nanoseconds}.${sequence}`;
		}


		//---------------------------------------------------------------------
		// ***The identifier is written on insert and never again.***
		function with_identifier( Document )
		{
			let document = jsongin.Clone( Document );
			if ( typeof document[ Storage.Settings.IdField ] === 'undefined' )
			{
				document[ Storage.Settings.IdField ] = jsonstor.NewUniqueID();
			}
			return document;
		}


		//=====================================================================
		// The translator.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***This adapter narrows nothing, and that is the point of the target.***
		//
		// `SqlExpression` is handed a column list because a field with no column lives in an
		// opaque payload; `ElasticExpression` is handed a mapping list because an unmapped field
		// is not indexed. Here the document ***is*** the row and every path is addressable, so
		// there is no list to hand over - `N1qlExpression` defaults `AllowedFields` to null for
		// exactly this case.
		function translator_options()
		{
			return {};
		}


		//---------------------------------------------------------------------
		// ***Does this criteria name one of the two fields which are not the caller's?***
		//
		// `jsonstor_sequence` and `jsonstor_document` are stored beside the document and taken
		// off it on the way out, so a condition on either would be decided by the server against
		// a field the caller's answer does not have. ***Which direction that goes depends on the
		// operator***, and one of the directions is the one a pushdown may never take: over the
		// stored value `{ jsonstor_sequence: { $exists: false } }` is false for every document,
		// and over the document jsongin is handed it is true for every document. A pushdown
		// which returns fewer documents than the criteria admits is a wrong answer nothing
		// downstream can correct.
		//
		// ***So the whole criteria goes to jsongin instead***, which is always right and merely
		// slow - the same trade every dropped operator in this family makes.
		//
		// ***A name is looked for as a value as well as a key***, because `$expr` names a field
		// with a string and carries no such key at all:
		// `{ $expr: { $gt: [ '$jsonstor_sequence', 5 ] } }`. A caller comparing some other field
		// against one of those literal strings costs itself a pushdown and gets the right
		// answer, which is the safe way round.
		function names_reserved_field( Node )
		{
			let short_type = jsongin.ShortType( Node );
			if ( short_type === 's' )
			{
				for ( let index = 0; index < RESERVED_FIELDS.length; index++ )
				{
					let reserved = RESERVED_FIELDS[ index ];
					if ( ( Node === reserved ) || ( Node === '$' + reserved ) ) { return true; }
					if ( Node.startsWith( reserved + '.' ) ) { return true; }
					if ( Node.startsWith( '$' + reserved + '.' ) ) { return true; }
				}
				return false;
			}
			if ( short_type === 'a' )
			{
				for ( let index = 0; index < Node.length; index++ )
				{
					if ( names_reserved_field( Node[ index ] ) ) { return true; }
				}
				return false;
			}
			if ( short_type !== 'o' ) { return false; }
			let keys = Object.keys( Node );
			for ( let index = 0; index < keys.length; index++ )
			{
				let key = keys[ index ];
				for ( let which = 0; which < RESERVED_FIELDS.length; which++ )
				{
					let reserved = RESERVED_FIELDS[ which ];
					if ( key === reserved ) { return true; }
					if ( key.startsWith( reserved + '.' ) ) { return true; }
				}
				if ( names_reserved_field( Node[ key ] ) ) { return true; }
			}
			return false;
		}


		//---------------------------------------------------------------------
		function translate( Criteria )
		{
			if ( names_reserved_field( Criteria ) )
			{
				return {
					Pushdown: '',
					Residual: Criteria,
					SortAbsorbed: false,
					ProjectionAbsorbed: false,
					LimitAbsorbed: false,
				};
			}
			return jsonstor.N1qlExpression.Translate( {
				Criteria: Criteria,
				Options: translator_options(),
			} );
		}


		//---------------------------------------------------------------------
		function report_scan( Options, Translation, Scanned, Matched )
		{
			jsonstor.ReportStatistics( Options, {
				Translator: 'N1qlExpression',
				Pushdown: Translation.Pushdown,
				PushdownRows: Scanned,
				Residual: Translation.Residual,
				ResidualRows: Matched,
			} );
			return;
		}


		//=====================================================================
		// Reading.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***One statement, whatever the criteria narrowed to.***
		//
		// The collection range and the pushdown are separate conjuncts because they answer
		// different questions - one is this adapter's bookkeeping and the other is the caller's
		// criteria - and a pushdown which rendered nothing simply leaves the range alone.
		//
		// ***The natural order is the sequence, and the server sorts it.*** Unlike
		// `jsonstor-elasticsearch`, which cannot sort on `_id` and pages with `search_after`,
		// the query service returns a whole result set and will order it on any path.
		function select_statement( Pushdown )
		{
			let where = collection_range();
			if ( Pushdown && Pushdown.length ) { where = `${where} AND (${Pushdown})`; }
			return `SELECT META(${KEYSPACE_ALIAS}).id AS jsonstor_key, ${KEYSPACE_ALIAS} AS jsonstor_value`
				+ ` FROM ${keyspace()}`
				+ ` WHERE ${where}`
				+ ` ORDER BY ${KEYSPACE_ALIAS}.\`${SEQUENCE_FIELD}\``;
		}


		//---------------------------------------------------------------------
		// ***A lookup by the identifier is answered by the key, not by a query.***
		//
		// `USE KEYS` reaches the data service directly: no index, no `request_plus`, and none of
		// the 200 ms the indexer's snapshot cadence costs. This adapter declares
		// `IndexHostedBy: 'database'`, and this is where that promise is kept.
		//
		// ***Only the plain equality shape, and deliberately only that.*** A range or a pattern
		// over the identifier has no set of keys to become. Anything else falls through to the
		// query, which is correct and merely slow.
		//
		// ***The residual still re-checks it***, which is what makes the shortcut safe: the key
		// is `String()` of the identifier, so a collection holding both `1` and `'1'` answers
		// the same key for both and jsongin discards the one the criteria did not ask for.
		function id_lookup_key( Criteria )
		{
			if ( jsongin.ShortType( Criteria ) !== 'o' ) { return null; }
			let keys = Object.keys( Criteria );
			if ( keys.length !== 1 ) { return null; }
			if ( keys[ 0 ] !== Storage.Settings.IdField ) { return null; }
			let value = Criteria[ keys[ 0 ] ];
			if ( !'nsb'.includes( jsongin.ShortType( value ) ) ) { return null; }
			return document_key( '' + value );
		}


		//---------------------------------------------------------------------
		// ***The documents this criteria admits, in natural order, each with its key.***
		async function find_entries( Criteria )
		{
			let translation = translate( Criteria );

			// ***A malformed criteria is refused before anything is read***, so the refusal does
			// not depend on the collection holding something.
			if ( translation.Residual !== null ) { jsongin.Query( {}, translation.Residual ); }

			let rows = [];
			let key = id_lookup_key( Criteria );
			if ( key !== null )
			{
				// See id_lookup_key. The residual is left in place on purpose, and the
				// consistency is not: a key read sees its own write with no index involved.
				translation = { Pushdown: `META().id = ${JSON.stringify( key )}`, Residual: Criteria };
				rows = await run( 'key read',
					`SELECT META(${KEYSPACE_ALIAS}).id AS jsonstor_key, ${KEYSPACE_ALIAS} AS jsonstor_value`
					+ ` FROM ${keyspace()} USE KEYS [${JSON.stringify( key )}]`,
					'not_bounded' );
			}
			else
			{
				rows = await run( 'query', select_statement( translation.Pushdown ) );
			}

			let entries = [];
			for ( let index = 0; index < rows.length; index++ )
			{
				let row = rows[ index ];
				let value = row.jsonstor_value;
				let document = value_to_document( value );
				if ( translation.Residual !== null )
				{
					if ( !jsongin.Query( document, translation.Residual ) ) { continue; }
				}
				entries.push( {
					Key: row.jsonstor_key,
					Sequence: ( jsongin.ShortType( value ) === 'o' ) ? ( value[ SEQUENCE_FIELD ] || '' ) : '',
					Document: document,
				} );
			}
			// The statement already sorted on the sequence, so the natural order arrived with
			// the documents rather than being imposed on them here.
			return { Entries: entries, Scanned: rows.length, Translation: translation };
		}


		//---------------------------------------------------------------------
		async function find_first( Criteria )
		{
			let search = await find_entries( Criteria );
			if ( search.Entries.length ) { return { Search: search, Found: search.Entries[ 0 ] }; }
			return { Search: search, Found: null };
		}


		//---------------------------------------------------------------------
		function criteria_matches_everything( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( 'lu'.includes( short_type ) ) { return true; }
			if ( Object.keys( Criteria ).length === 0 ) { return true; }
			return false;
		}


		//---------------------------------------------------------------------
		function check_criteria( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( !'olu'.includes( short_type ) ) { throw new Error( `Criteria must be an object, null, or undefined.` ); }
			return;
		}


		//=====================================================================
		// Writing.
		//=====================================================================


		//---------------------------------------------------------------------
		// ***Writes go out in three passes, and the order is not cosmetic.***
		//
		// An `INSERT` refuses a key which is already there, which is how the primary key
		// contract is enforced - so an insert has to be attempted ***before*** anything frees a
		// key, or a document could be deleted for a write which then fails. Upserts do not
		// collide, and deletes go last because a delete which finds nothing is not a failure.
		//
		// ***Batched, because a statement is a round trip.*** Every operation here is by key, so
		// none of the three needs the index and none pays for `request_plus`.
		async function write_actions( Actions )
		{
			if ( !Actions.length ) { return; }
			await ensure_index();

			let inserts = Actions.filter( ( action ) => action.Operation === 'insert' );
			let upserts = Actions.filter( ( action ) => action.Operation === 'upsert' );
			let deletes = Actions.filter( ( action ) => action.Operation === 'delete' );

			await write_values( 'INSERT', inserts );
			await write_values( 'UPSERT', upserts );
			await delete_keys( deletes );
			return;
		}


		//---------------------------------------------------------------------
		async function write_values( Verb, Actions )
		{
			for ( let start = 0; start < Actions.length; start += WRITE_BATCH_SIZE )
			{
				let batch = Actions.slice( start, start + WRITE_BATCH_SIZE );
				let tuples = [];
				for ( let index = 0; index < batch.length; index++ )
				{
					tuples.push( `(${JSON.stringify( batch[ index ].Key )}, ${JSON.stringify( batch[ index ].Value )})` );
				}
				let answer = await n1ql(
					`${Verb} INTO ${bucket_reference()} (KEY, VALUE) VALUES ${tuples.join( ', ' )}`,
					'not_bounded' );
				if ( answer.Error )
				{
					// ***A duplicate identifier is refused by name.*** Couchbase reports it as a
					// DML error, which is the truth about its mechanism and says nothing to a
					// caller who wrote the same key twice.
					if ( is_duplicate_key( answer.Error ) )
					{
						throw new Error( `A document with the primary key [${Storage.Settings.IdField}] already exists in [${Storage.Settings.CollectionName}].` );
					}
					throw n1ql_error( 'document write', answer.Error );
				}
			}
			return;
		}


		//---------------------------------------------------------------------
		async function delete_keys( Actions )
		{
			for ( let start = 0; start < Actions.length; start += WRITE_BATCH_SIZE )
			{
				let batch = Actions.slice( start, start + WRITE_BATCH_SIZE );
				let keys = batch.map( ( action ) => JSON.stringify( action.Key ) );
				// ***`USE KEYS` on a DELETE is what keeps it out of the index.*** A `DELETE ...
				// WHERE` names its rows through the same index a `SELECT` reads, and would then
				// need `request_plus` and the 200 ms with it.
				await run( 'document delete',
					`DELETE FROM ${keyspace()} USE KEYS [${keys.join( ', ' )}]`,
					'not_bounded' );
			}
			return;
		}


		//---------------------------------------------------------------------
		// ***What to write so that one existing document becomes another.***
		//
		// ***The key is the identifier, so a write which changes it is a move.*** In place when
		// the identifier is unchanged; otherwise the new document is inserted and the old key
		// removed, in that order, so a refused insert leaves the collection as it was. The
		// sequence is carried over either way, because a document keeps its place in the natural
		// order.
		function stage_replacement( Entry, Document )
		{
			let key = required_key( Document );
			if ( key === Entry.Key )
			{
				return [ { Operation: 'upsert', Key: key, Value: document_to_value( Document, Entry.Sequence ) } ];
			}
			return [
				{ Operation: 'insert', Key: key, Value: document_to_value( Document, Entry.Sequence ) },
				{ Operation: 'delete', Key: Entry.Key },
			];
		}


		//=====================================================================
		// StorageInfo
		//=====================================================================


		// ***The version comes off the query service, not the management port.***
		//
		// `ds_version()` answers `8.0.2-5503-community` on 8.0 and `5.0.1-5003-community` on the
		// floor - measured on both - so this adapter needs one port and one setting where the
		// management REST on 8091 would have cost a second of each.
		Storage.StorageInfo = async function ( Options )
		{
			let rows = await run( 'server version', 'SELECT RAW ds_version()', 'not_bounded' );
			let version = ( rows.length && ( typeof rows[ 0 ] === 'string' ) ) ? rows[ 0 ] : '';
			return jsonstor.BuildStorageInfo( Storage, {
				Product: 'Couchbase',
				Version: version,
				Endpoint: base_url(),
			} );
		};


		//---------------------------------------------------------------------
		// ***The floor is checked against the server once, on the first operation.***
		//
		// The transport is stateless and `GetStorage` is synchronous, so a server below the
		// floor cannot be caught at construction and surfaces on the first operation instead.
		// A crossed boundary is remembered; a server which did not answer is not.
		let floor_check = null;
		async function ensure_floor_checked()
		{
			if ( floor_check !== null )
			{
				if ( floor_check.Error ) { throw floor_check.Error; }
				return;
			}
			floor_check = {};
			try { await Storage.StorageInfo(); }
			catch ( error )
			{
				if ( error && error.DialectBoundary ) { floor_check.Error = error; }
				else { floor_check = null; }
				throw error;
			}
			return;
		}


		//=====================================================================
		// DropStorage
		//=====================================================================


		// ***One statement, and it removes this collection's documents and no neighbour's.***
		// The bucket is not this storage's to drop, and neither is the primary index on it.
		Storage.DropStorage = async function ( Options )
		{
			await ensure_floor_checked();
			await ensure_index();
			await run( 'collection drop', `DELETE FROM ${keyspace()} WHERE ${collection_range()}` );
			return true;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		// ***There is nothing here to flush, and the thing which sounds like it is dangerous.***
		// The data service persists on its own cadence and offers no per-collection commit. What
		// the management API does offer is a ***bucket*** flush, which would delete every
		// neighbour's documents to answer a question about this collection.
		Storage.FlushStorage = async function ( Options )
		{
			await ensure_floor_checked();
			return true;
		};


		//=====================================================================
		// RefreshIndex
		//=====================================================================


		// ***This is the one adapter where the fourteenth function maps onto something real.***
		//
		// Every criteria query here already asks for `request_plus`, so this is a caller's way
		// to be certain rather than a repair - and what it costs is the measurement this target
		// is built around: the indexer publishes a snapshot every 200 ms and nothing can be
		// faster than the next one.
		Storage.RefreshIndex = async function ( Options )
		{
			await ensure_floor_checked();
			await ensure_index();
			await run( 'index refresh',
				`SELECT RAW 1 FROM ${keyspace()} WHERE ${collection_range()} LIMIT 1` );
			return 0;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();

			// ***An unfiltered count never reads a document.*** `COUNT(*)` over the collection
			// range is this medium's version of the cheap answer every other adapter's count of
			// everything gets.
			if ( criteria_matches_everything( Criteria ) )
			{
				await ensure_index();
				let rows = await run( 'count',
					`SELECT RAW COUNT(*) FROM ${keyspace()} WHERE ${collection_range()}` );
				let counted = rows.length ? ( Number( rows[ 0 ] ) || 0 ) : 0;
				report_scan( Options, translate( Criteria ), counted, counted );
				return counted;
			}

			let search = await find_entries( Criteria );
			report_scan( Options, search.Translation, search.Scanned, search.Entries.length );
			return search.Entries.length;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function ( Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			await ensure_floor_checked();
			let document = with_identifier( Document );
			// ***`INSERT` rather than `UPSERT`, and that is the primary key contract.***
			// `UPSERT` overwrites a document with the same identifier; `INSERT` refuses it. This
			// adapter declares `IndexHostedBy: 'database'`, which says the server enforces the
			// key - so it has to be asked to.
			await write_actions( [ {
				Operation: 'insert',
				Key: required_key( document ),
				Value: document_to_value( document, new_sequence() ),
			} ] );
			if ( Options.ReturnDocuments ) { return document; }
			return 1;
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function ( Documents, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Documents ) !== 'a' ) { throw new Error( `Documents must be an array of objects.` ); }
			await ensure_floor_checked();
			let inserted = [];
			let actions = [];
			for ( let index = 0; index < Documents.length; index++ )
			{
				let document = with_identifier( Documents[ index ] );
				inserted.push( document );
				actions.push( {
					Operation: 'insert',
					Key: required_key( document ),
					Value: document_to_value( document, new_sequence() ),
				} );
			}
			await write_actions( actions );
			if ( Options.ReturnDocuments ) { return inserted; }
			return inserted.length;
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			await ensure_index();
			let search = await find_first( Criteria );
			let document = null;
			if ( search.Found ) { document = jsongin.Project( search.Found.Document, Projection ); }
			report_scan( Options, search.Search.Translation, search.Search.Scanned, document ? 1 : 0 );
			return document;
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			await ensure_index();
			let search = await find_entries( Criteria );
			let documents = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				documents.push( jsongin.Project( search.Entries[ index ].Document, Projection ) );
			}
			report_scan( Options, search.Translation, search.Scanned, documents.length );
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		// ***The sort and the limit are applied here rather than by the server.***
		//
		// N1QL can do both, and `N1qlExpression` reports `SortAbsorbed: false` and
		// `LimitAbsorbed: false` - so this is the translator's declaration carried out rather
		// than a shortcut around it. Absorbing them is a later, additive change.
		Storage.FindMany2 = async function ( Criteria, Projection, Sort, MaxCount, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			await ensure_index();
			let search = await find_entries( Criteria );
			let documents = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				documents.push( jsongin.Project( search.Entries[ index ].Document, Projection ) );
			}
			if ( Sort ) { documents = jsongin.Sort( documents, Sort ); }
			if ( MaxCount && ( MaxCount > 0 ) && ( documents.length >= MaxCount ) ) { documents = documents.splice( 0, MaxCount ); }
			report_scan( Options, search.Translation, search.Scanned, documents.length );
			return documents;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		// Refuses an update or a replace which moved the identifier. See
		// jsonx/.plans/primary-keys-and-indexes.md.
		function check_key_move( Before, After )
		{
			if ( Storage.PrimaryKeyInfo.Mutable ) { return; }
			if ( Before === After ) { return; }
			throw new Error( `The primary key [${Storage.Settings.IdField}] is not mutable, and this operation would change it from [${Before}] to [${After}].` );
		}


		Storage.UpdateOne = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			await ensure_index();
			let search = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( search.Found )
			{
				modified = jsongin.Update( search.Found.Document, Updates );
				check_key_move( search.Found.Document[ Storage.Settings.IdField ], modified[ Storage.Settings.IdField ] );
				await write_actions( stage_replacement( search.Found, modified ) );
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			await ensure_index();
			let search = await find_entries( Criteria );
			let modified = [];
			let actions = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				let entry = search.Entries[ index ];
				let document = jsongin.Update( entry.Document, Updates );
				check_key_move( entry.Document[ Storage.Settings.IdField ], document[ Storage.Settings.IdField ] );
				modified.push( document );
				actions = actions.concat( stage_replacement( entry, document ) );
			}
			await write_actions( actions );
			if ( Options.ReturnDocuments ) { return modified; }
			return modified.length;
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ( Criteria, Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			check_criteria( Criteria );
			await ensure_floor_checked();
			await ensure_index();
			let search = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( search.Found )
			{
				modified = jsongin.Clone( Document );
				// ***A replacement with no primary key carries the matched document's key over.***
				let key_field = Storage.Settings.IdField;
				if ( typeof modified[ key_field ] === 'undefined' )
				{
					let carried = search.Found.Document[ key_field ];
					if ( typeof carried !== 'undefined' ) { modified[ key_field ] = carried; }
				}
				check_key_move( search.Found.Document[ key_field ], modified[ key_field ] );
				await write_actions( stage_replacement( search.Found, modified ) );
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			await ensure_index();
			let search = await find_first( Criteria );
			let deleted = null;
			let deleted_count = 0;
			if ( search.Found )
			{
				deleted = search.Found.Document;
				await write_actions( [ { Operation: 'delete', Key: search.Found.Key } ] );
				deleted_count++;
			}
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted_count;
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			await ensure_floor_checked();
			await ensure_index();
			let search = await find_entries( Criteria );
			let deleted = [];
			let actions = [];
			for ( let index = 0; index < search.Entries.length; index++ )
			{
				let entry = search.Entries[ index ];
				deleted.push( entry.Document );
				actions.push( { Operation: 'delete', Key: entry.Key } );
			}
			await write_actions( actions );
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted.length;
		};


		//=====================================================================
		// N1qlTranslation
		//
		// ***What an N1QL translating adapter advertises beyond the Storage interface.*** Its
		// presence is the capability declaration, the same way `Storage.SqlTranslation`,
		// `Storage.MangoTranslation`, `Storage.ElasticTranslation` and `Storage.DynamoTranslation`
		// are: a suite asks the constructed Storage rather than consulting a list somewhere which
		// could disagree with it. Constructing a Storage opens no connection, so the question is
		// answerable while the server is down.
		//=====================================================================


		Storage.N1qlTranslation = {
			TranslatorName: 'N1qlExpression',
			Options: translator_options(),
			// ***The clause this adapter puts in front of every pushdown.*** A suite which wants
			// to send a translated criteria to a live server needs the same collection range the
			// adapter uses, and deriving it a second time is how the two would drift apart.
			CollectionRange: collection_range,
		};


		//=====================================================================
		return Storage;
	},

};


//---------------------------------------------------------------------
// ***One prime, and the floor took five servers to find.***
//
// Couchbase Community 8.0.2, 6.6.0, 5.1.1 and 5.0.1 answer all thirty one of jsongin's query
// operators identically. ***4.5.1 has no `BITAND`*** and drops the four `$bits*` operators with
// it, which is a difference in what the translator may render and therefore a real boundary.
//
// ***It was briefly recorded as "not a query-language boundary" on the strength of three flat
// servers***, and one server below the surveyed range disproved that. ***A flat result is
// evidence about the range you sampled, not about the product.***
//
// ***And the floor is a storage claim as well as a language one***, which is why 5.0.1 was
// started again and asked directly rather than trusted: `ds_version()`, `IS NOT VALUED`,
// `ANY .. SATISFIES`, `REGEXP_CONTAINS`, `TO_STRING`, `TYPE()`, `TRUNC` and `BITAND` all answer
// there, the key range isolates a collection there, and `INSERT` refuses a duplicate key there.
// ***Two of those answers differ from 8.0's and both are handled by code above*** - the existing
// index reports 5000 rather than 4300, and the duplicate key message loses a colon.
//
// See jsonx/.plans/wave-5-query-languages.md and jsonx/.plans/versioned-adapters.md.

const COUCHBASE_V50 = {
	AdapterName: 'jsonstor-couchbase-v5.0',
	AdapterDescription: module.exports.AdapterDescription,
	GetAdapter: module.exports.GetAdapter,
	Version: [ 5, 0 ],
	MeasuredTo: [ 8, 0, 2 ],
};

module.exports.Adapters = [ COUCHBASE_V50 ];

// ***The bare name is listed here rather than left on the plugin object***, so `GetStorage`
// reports the prime it resolved to instead of reporting itself as its own profile.
module.exports.Aliases = {
	'jsonstor-couchbase': 'jsonstor-couchbase-v5.0',
	'jsonstor-couchbase-v5': 'jsonstor-couchbase-v5.0',
	'jsonstor-couchbase-v5.1': 'jsonstor-couchbase-v5.0',
	'jsonstor-couchbase-v6': 'jsonstor-couchbase-v5.0',
	'jsonstor-couchbase-v6.6': 'jsonstor-couchbase-v5.0',
	'jsonstor-couchbase-v7': 'jsonstor-couchbase-v5.0',
	'jsonstor-couchbase-v8': 'jsonstor-couchbase-v5.0',
	'jsonstor-couchbase-v8.0': 'jsonstor-couchbase-v5.0',
};
