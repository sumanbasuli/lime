package models

import "github.com/sumanbasuli/lime/shopkeeper/internal/safelog"

// Link-check projections are response copies. Stored URLs, including queries,
// remain available to the worker and to explicit recheck actions.
func PublicLinkCheck(check LinkCheck) LinkCheck {
	check.URL = safelog.PublicURLText(check.URL)
	if check.Error != nil {
		value := safelog.Text(*check.Error)
		check.Error = &value
	}
	return check
}

func PublicLinkChecks(checks []LinkCheck) []LinkCheck {
	if checks == nil {
		return nil
	}
	public := make([]LinkCheck, len(checks))
	for i, check := range checks {
		public[i] = PublicLinkCheck(check)
	}
	return public
}

func PublicLinkSource(source LinkSource) LinkSource {
	source.PageURL = safelog.PublicURLText(source.PageURL)
	return source
}

func PublicLinkSources(sources []LinkSource) []LinkSource {
	if sources == nil {
		return nil
	}
	public := make([]LinkSource, len(sources))
	for i, source := range sources {
		public[i] = PublicLinkSource(source)
	}
	return public
}

func PublicLinkResult(result LinkResult) LinkResult {
	result.TargetURL = safelog.PublicURLText(result.TargetURL)
	if result.FinalURL != nil {
		value := safelog.PublicURLText(*result.FinalURL)
		result.FinalURL = &value
	}
	if result.Error != nil {
		value := safelog.Text(*result.Error)
		result.Error = &value
	}
	result.Sources = PublicLinkSources(result.Sources)
	return result
}

func PublicLinkResults(results []LinkResult) []LinkResult {
	if results == nil {
		return nil
	}
	public := make([]LinkResult, len(results))
	for i, result := range results {
		public[i] = PublicLinkResult(result)
	}
	return public
}
