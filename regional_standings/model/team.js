"use strict";

const nthHighest = require('./util/nth_highest');
const Region = require('./util/region');
const TEAM_OVERLAP_TO_SHARE_ROSTER = 3;

class TeamEvent {
    constructor( event, teamId ) {
        this.event = event;
        this.teamId = teamId;

        let prizeEntry = event.prizeDistributionByTeamId[teamId];
        this.winnings = ( prizeEntry === undefined ) ? 0 : prizeEntry.prize;
    }

    getTeamWinnings() {
        return this.winnings;
    }
}

class TeamMatch {
    constructor( team, match ) {
        if( match.team1 !== team && match.team2 !== team )
        {
            throw new Error( "adding a match to a team that didn't participate in it" );
        }

        this.match      = match;
        this.team       = team;
        this.teamNumber = ( match.team1 === team ) ? 1 : 2;
        this.isWinner   = match.winningTeam === this.teamNumber;
        this.opponent   = ( this.teamNumber === 1 ) ? match.team2 : match.team1;
    }
}

function getPluralityRegion( players ) {
    let teamCountries = players.map( el => el.countryIso );
    let regionAssignment = [0, 0, 0]; //EU, AMER, ROW

    teamCountries.forEach( el => { 
        regionAssignment[Region.getCountryRegion(el)]+=1 
    });

    let region = regionAssignment.findIndex( el => el === Math.max(...regionAssignment) );
    return region;
}


class Team {
    static TeamMatch = TeamMatch;
    static TeamEvent = TeamEvent;

    constructor( rosterId, name, players ) {
        this.rosterId = rosterId;
        this.name = name;
        this.players = players;
        this.teamMatches = [];
        this.wonMatches = [];
        this.matchesPlayed = 0;
        this.eventMap = new Map();
        this.lastPlayed = 0;
        this.modifiers = {};
        this.region = getPluralityRegion( this.players );
    }

    // A past team is considered as the same entity as a more recent one,
    // if it shares enough players.
    sharesRoster( players )
    {
        let overlap = 0;
        players.forEach( pNew => {
            this.players.forEach( pExisting => {
                if( pNew.playerId === pExisting.playerId ) {
                    overlap += 1;
                }
            } );
        } );

        return ( overlap >= TEAM_OVERLAP_TO_SHARE_ROSTER );
    }

    // We only link the team ids from the source data to our teams in the context
    // of an event, because the same team might replace its players and thus would
    // not be considered the same roster -- we don't want to credit the new roster
    // with the old teams winnings, and we do want to credit some players with their
    // past winnings after they have changed teams.
    recordEventParticipation( event, teamId )
    {
        if( event === undefined )
            return;

        if( this.eventMap.has( event.eventId ) )
            return;

        this.eventMap.set( event.eventId, new TeamEvent( event, teamId ) );
    }

    accumulateMatch( match )
    {
        const teamMatch = new TeamMatch( this, match )

        this.teamMatches.push( teamMatch );
        if( teamMatch.isWinner ) {
            this.wonMatches.push( teamMatch );
        }
    }

    static initializeSeedingModifiers( teams, context )
    {
        // If there is no team value, exit the function
        if( teams.length === 0 ){
            return;
        }

        // Phase 1: Do calculations we can do directly from this team's data -- we don't rely on
        // any other team info to figure this data out.
        teams.forEach( team => {
            team.matchesPlayed = team.teamMatches.length;
            team.lastPlayed = Math.max( ...team.teamMatches.map( teamMatch => teamMatch.match.matchStartTime ) );
            team.distinctTeamsDefeated = 0;
            team.scaledPrizePool = 0;

            // Calculate the most recent match against each opponent
            // We are going to use this to discount the prestige factor if you haven't defeated a team recently.
            // (It's still better to have defeated them than not, for seeding purposes, just not as good as
            // if they were defeated recently)
            let opponentMap = new Map();
            team.wonMatches.forEach( wonMatch => {
                let opp = wonMatch.opponent;
                let matchTime = wonMatch.match.matchStartTime;
                let prevBestMatchTime = opponentMap.get( opp );
                if( prevBestMatchTime === undefined || prevBestMatchTime < matchTime )
                {
                    opponentMap.set( opp, matchTime );
                }
            });

            opponentMap.forEach( ( lastWinTime, opp ) => {
                team.distinctTeamsDefeated += context.getTimestampModifier( lastWinTime );
            } );
    
            // Also calculate winnings
            team.eventMap.forEach( teamEvent => {
                team.scaledPrizePool += teamEvent.getTeamWinnings() * context.getTimestampModifier( teamEvent.event.lastMatchTime );
            } );
        } );

        // Phase 2 relies on the data from *all* teams in phase 1 being calculated.
        // we want to know relative data -- such as whether this team's winnings are representative
        // of the top teams in the world, or if a team has beaten a typical number of opponents.
        let referencePrizePool     = nthHighest( teams.map( t => t.scaledPrizePool ), context.getPrizePoolNth() );
        let referenceOpponentCount = nthHighest( teams.map( t => t.distinctTeamsDefeated ), context.getDistinctOpponentNth() );

        teams.forEach( team => {
            team.winnings = Math.min( team.scaledPrizePool / referencePrizePool, 1 );
            team.teamsDefeated = Math.min( team.distinctTeamsDefeated / referenceOpponentCount, 1 );
        } );

        // Phase 3 looks at each team's opponents and rates each team highly if it can regularly win against other prestigous teams.
        teams.forEach( team => {
            let sumScaledPrizeContribution = 0;
            let sumScaledOpponentContribution = 0;
            let sumScaledDenominator = 1;
    
            team.wonMatches.forEach( teamMatch => {
                let matchModifier = context.getTimestampModifier( teamMatch.match.matchStartTime );

                sumScaledPrizeContribution += teamMatch.opponent.winnings * matchModifier;
                sumScaledOpponentContribution += teamMatch.opponent.teamsDefeated * matchModifier;
                sumScaledDenominator += matchModifier;
            } );
    
            sumScaledDenominator = Math.max(10,sumScaledDenominator); // in case you don't have much data or it's all very old
        
            team.opponentWinnings = sumScaledPrizeContribution / sumScaledDenominator;
            team.opponentVictories = sumScaledOpponentContribution / sumScaledDenominator;
        } );

        // Finally, build modifiers from calculated values
        let curveFunction = ( value ) => {
            return Math.pow( 1 / ( 1 + Math.abs(Math.log10( value )) ), 1 );
        }
        let powerFunction ( value ) => {
            return Math.pow( value, 1 );
        }
        
        teams.forEach( team => {
            team.modifiers.bounty       = curveFunction( team.opponentWinnings );
            team.modifiers.selfBounty   = curveFunction( team.winnings );
            team.modifiers.opponent     = powerFunction( team.opponentVictories );
            team.modifiers.selfOpponent = powerFunction( team.teamsDefeated );
        } );
    }
}

module.exports = Team;
